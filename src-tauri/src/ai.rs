use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::db::{setting, Db};
use crate::error::{err, AppError, LockExt, Result};

const SERVICE: &str = "com.astrodev.bluephoenix";

// ---------- secrets (OS keychain) ----------

fn entry(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, name).map_err(|e| AppError::Msg(format!("Keychain error: {e}")))
}

pub fn secret_get(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok().filter(|s| !s.is_empty())
}

#[tauri::command]
pub async fn secret_set(name: String, value: String) -> Result<()> {
    let e = entry(&name)?;
    if value.is_empty() {
        let _ = e.delete_credential();
        return Ok(());
    }
    e.set_password(&value).map_err(|e| AppError::Msg(format!("Could not store the secret: {e}")))
}

#[tauri::command]
pub async fn secret_has(name: String) -> bool {
    secret_get(&name).is_some()
}

// ---------- providers ----------

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub local: bool,
    pub base_url: &'static str,
    pub needs_key: bool,
    /// "openai" (OpenAI-compatible chat completions) or "anthropic".
    pub protocol: &'static str,
}

const fn p(id: &'static str, name: &'static str, local: bool, base_url: &'static str, needs_key: bool, protocol: &'static str) -> Provider {
    Provider { id, name, local, base_url, needs_key, protocol }
}

pub const PROVIDERS: &[Provider] = &[
    p("ollama", "Ollama", true, "http://localhost:11434/v1", false, "openai"),
    p("lmstudio", "LM Studio", true, "http://localhost:1234/v1", false, "openai"),
    p("llamacpp", "llama.cpp (GGUF file)", true, "http://127.0.0.1:8080/v1", false, "openai"),
    p("local-custom", "Other local server", true, "http://localhost:8000/v1", false, "openai"),
    p("openai", "OpenAI", false, "https://api.openai.com/v1", true, "openai"),
    p("anthropic", "Anthropic", false, "https://api.anthropic.com/v1", true, "anthropic"),
    p("openrouter", "OpenRouter", false, "https://openrouter.ai/api/v1", true, "openai"),
    p("google", "Google Gemini", false, "https://generativelanguage.googleapis.com/v1beta/openai", true, "openai"),
    p("groq", "Groq", false, "https://api.groq.com/openai/v1", true, "openai"),
    p("mistral", "Mistral", false, "https://api.mistral.ai/v1", true, "openai"),
    p("deepseek", "DeepSeek", false, "https://api.deepseek.com/v1", true, "openai"),
    p("xai", "xAI", false, "https://api.x.ai/v1", true, "openai"),
    p("together", "Together AI", false, "https://api.together.xyz/v1", true, "openai"),
    p("cloud-custom", "Other OpenAI-compatible", false, "https://example.com/v1", true, "openai"),
];

#[tauri::command]
pub fn ai_providers() -> Vec<Provider> {
    PROVIDERS.to_vec()
}

fn provider(id: &str) -> Result<Provider> {
    PROVIDERS.iter().copied().find(|p| p.id == id).ok_or_else(|| AppError::Msg(format!("Unknown AI provider '{id}'")))
}

pub fn key_name(provider_id: &str) -> String {
    format!("ai:{provider_id}")
}

fn http(timeout_s: u64) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(Duration::from_secs(timeout_s)).user_agent("BluePhoenix").build()?)
}

fn auth(req: reqwest::RequestBuilder, prov: &Provider, key: Option<&str>) -> reqwest::RequestBuilder {
    match (prov.protocol, key) {
        ("anthropic", Some(k)) => req.header("x-api-key", k).header("anthropic-version", "2023-06-01"),
        ("anthropic", None) => req.header("anthropic-version", "2023-06-01"),
        (_, Some(k)) => req.bearer_auth(k),
        _ => req,
    }
}

async fn error_text(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["error"]["message"].as_str().map(String::from).or_else(|| v["error"].as_str().map(String::from))
        })
        .unwrap_or(body);
    format!("{status}: {}", msg.chars().take(400).collect::<String>())
}

fn connect_hint(e: reqwest::Error, prov: &Provider) -> AppError {
    if e.is_connect() && prov.local {
        AppError::Msg(format!("Could not reach {}. Is it running?", prov.name))
    } else if e.is_timeout() {
        AppError::Msg("The AI request timed out".into())
    } else {
        AppError::Http(e)
    }
}

/// Resolves provider, base URL, key and model from saved settings.
struct Resolved {
    prov: Provider,
    base: String,
    key: Option<String>,
    model: String,
}

fn resolve(db: &Db) -> Result<Resolved> {
    let mode = setting(db, "ai.mode").unwrap_or_else(|| "local".into());
    let pid = setting(db, &format!("ai.provider.{mode}"))
        .unwrap_or_else(|| if mode == "local" { "ollama".into() } else { "openai".into() });
    let prov = provider(&pid)?;
    let base = setting(db, &format!("ai.baseUrl.{pid}")).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| prov.base_url.to_string());
    let model = setting(db, &format!("ai.model.{pid}")).unwrap_or_default();
    if model.is_empty() {
        return err("No AI model selected. Open Settings → AI and pick one.");
    }
    let key = secret_get(&key_name(&pid));
    if prov.needs_key && key.is_none() {
        return err(format!("No API key saved for {}. Add it in Settings → AI.", prov.name));
    }
    Ok(Resolved { prov, base: base.trim_end_matches('/').to_string(), key, model })
}

#[tauri::command]
pub async fn ai_models(provider_id: String, base_url: Option<String>, api_key: Option<String>) -> Result<Vec<String>> {
    let prov = provider(&provider_id)?;
    let base = base_url.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| prov.base_url.to_string());
    let key = api_key.filter(|s| !s.is_empty()).or_else(|| secret_get(&key_name(&provider_id)));
    if prov.needs_key && key.is_none() {
        return err("Enter an API key first");
    }
    let url = format!("{}/models", base.trim_end_matches('/'));
    let resp = auth(http(20)?.get(&url), &prov, key.as_deref()).send().await.map_err(|e| connect_hint(e, &prov))?;
    if !resp.status().is_success() {
        return err(error_text(resp).await);
    }
    let v: Value = resp.json().await?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .or_else(|| v["models"].as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()))
                .map(|s| s.trim_start_matches("models/").to_string())
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

pub fn build_openai_body(model: &str, system: &str, prompt: &str, json_mode: bool) -> Value {
    let mut body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ],
        "stream": false
    });
    if json_mode {
        body["response_format"] = json!({"type": "json_object"});
    }
    body
}

pub fn build_anthropic_body(model: &str, system: &str, prompt: &str, max_tokens: u32) -> Value {
    json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": prompt}]
    })
}

#[tauri::command]
pub async fn ai_complete(
    db: State<'_, Db>,
    system: String,
    prompt: String,
    max_tokens: Option<u32>,
    json_mode: Option<bool>,
) -> Result<String> {
    complete(&db, &system, &prompt, max_tokens, json_mode.unwrap_or(false)).await
}

/// "Provider · model" of the AI setup saved in Settings, or the reason it is unusable.
pub fn active_model(db: &Db) -> Result<String> {
    let r = resolve(db)?;
    Ok(format!("{} · {}", r.prov.name, r.model))
}

/// Runs one completion with the provider and model saved in Settings (shared by the app and the CLI).
pub async fn complete(db: &Db, system: &str, prompt: &str, max_tokens: Option<u32>, json_mode: bool) -> Result<String> {
    let r = resolve(db)?;
    let client = http(600)?;
    if r.prov.protocol == "anthropic" {
        let body = build_anthropic_body(&r.model, system, prompt, max_tokens.unwrap_or(4096));
        let resp = auth(client.post(format!("{}/messages", r.base)), &r.prov, r.key.as_deref())
            .json(&body)
            .send()
            .await
            .map_err(|e| connect_hint(e, &r.prov))?;
        if !resp.status().is_success() {
            return err(error_text(resp).await);
        }
        let v: Value = resp.json().await?;
        let text: String = v["content"]
            .as_array()
            .map(|a| a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        return Ok(text);
    }
    let body = build_openai_body(&r.model, system, prompt, json_mode);
    let mut resp = auth(client.post(format!("{}/chat/completions", r.base)), &r.prov, r.key.as_deref())
        .json(&body)
        .send()
        .await
        .map_err(|e| connect_hint(e, &r.prov))?;
    // Some servers reject response_format; retry once without it.
    if !resp.status().is_success() && json_mode {
        let retry = build_openai_body(&r.model, system, prompt, false);
        resp = auth(client.post(format!("{}/chat/completions", r.base)), &r.prov, r.key.as_deref())
            .json(&retry)
            .send()
            .await
            .map_err(|e| connect_hint(e, &r.prov))?;
    }
    if !resp.status().is_success() {
        return err(error_text(resp).await);
    }
    let v: Value = resp.json().await?;
    let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    if text.trim().is_empty() {
        return err("The model returned an empty answer");
    }
    Ok(text)
}

// ---------- auto-start of local servers (Ollama, LM Studio) ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalAiStatus {
    pub provider: String,
    /// "running" (already up), "started" (we launched it) or "failed"
    pub state: String,
    pub message: String,
}

fn is_local_url(base: &str) -> bool {
    let host = base.split("://").nth(1).unwrap_or(base).split(['/', ':']).next().unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0")
}

async fn server_is_up(base: &str) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_millis(1500)).build() else {
        return false;
    };
    client.get(format!("{}/models", base.trim_end_matches('/'))).send().await.is_ok()
}

fn detached(cmd: &mut Command) -> std::io::Result<Child> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn()
}

/// Returns Ok(true) if something was launched, Ok(false) if the program is not installed.
fn launch_ollama() -> Result<bool> {
    if cfg!(target_os = "macos") {
        let home_app = dirs::home_dir().map(|h| h.join("Applications/Ollama.app"));
        if std::path::Path::new("/Applications/Ollama.app").exists() || home_app.is_some_and(|p| p.exists()) {
            detached(Command::new("open").args(["-g", "-a", "Ollama"]))?;
            return Ok(true);
        }
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let exe = std::path::Path::new(&local).join("Programs/Ollama/ollama app.exe");
            if exe.exists() {
                detached(&mut Command::new(exe))?;
                return Ok(true);
            }
        }
    }
    if let Ok(bin) = which::which("ollama") {
        detached(Command::new(bin).arg("serve"))?;
        return Ok(true);
    }
    Ok(false)
}

fn launch_lmstudio() -> Result<bool> {
    let lms = which::which("lms").ok().or_else(|| {
        let p = dirs::home_dir()?.join(".lmstudio/bin").join(if cfg!(windows) { "lms.exe" } else { "lms" });
        p.exists().then_some(p)
    });
    if let Some(lms) = lms {
        detached(Command::new(lms).args(["server", "start"]))?;
        return Ok(true);
    }
    if cfg!(target_os = "macos") && std::path::Path::new("/Applications/LM Studio.app").exists() {
        detached(Command::new("open").args(["-g", "-a", "LM Studio"]))?;
        return Ok(true);
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let exe = std::path::Path::new(&local).join("Programs/LM Studio/LM Studio.exe");
            if exe.exists() {
                detached(&mut Command::new(exe))?;
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Makes sure the selected local provider (Ollama or LM Studio) is running, starting it if needed.
/// With `only_if_configured`, nothing happens until the user has picked a model for that provider.
pub async fn ensure_local_server(db: &Db, only_if_configured: bool) -> Option<LocalAiStatus> {
    if setting(db, "ai.mode").unwrap_or_else(|| "local".into()) != "local" {
        return None;
    }
    if setting(db, "ai.autostart").as_deref() == Some("false") {
        return None;
    }
    let pid = setting(db, "ai.provider.local").unwrap_or_else(|| "ollama".into());
    if pid != "ollama" && pid != "lmstudio" {
        return None;
    }
    if only_if_configured && setting(db, &format!("ai.model.{pid}")).unwrap_or_default().is_empty() {
        return None;
    }
    let prov = provider(&pid).ok()?;
    let base = setting(db, &format!("ai.baseUrl.{pid}")).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| prov.base_url.to_string());
    if !is_local_url(&base) {
        return None; // a server on another machine is not ours to start
    }
    let status = |state: &str, message: String| Some(LocalAiStatus { provider: prov.name.into(), state: state.into(), message });
    if server_is_up(&base).await {
        return status("running", format!("{} is running", prov.name));
    }
    let launched = if pid == "ollama" { launch_ollama() } else { launch_lmstudio() };
    match launched {
        Ok(false) => None, // not installed: stay quiet
        Err(e) => status("failed", format!("Could not start {}: {e}", prov.name)),
        Ok(true) => {
            for _ in 0..30 {
                tokio::time::sleep(Duration::from_millis(700)).await;
                if server_is_up(&base).await {
                    return status("started", format!("Started {}", prov.name));
                }
            }
            if pid == "lmstudio" {
                status("failed", "LM Studio was opened, but its local server is not running. Start it in LM Studio's Developer tab.".into())
            } else {
                status("failed", format!("{} was launched but is not answering yet", prov.name))
            }
        }
    }
}

#[tauri::command]
pub async fn ai_ensure_local(db: State<'_, Db>) -> Result<Option<LocalAiStatus>> {
    Ok(ensure_local_server(&db, false).await)
}

// ---------- llama.cpp (GGUF) ----------

#[derive(Default)]
pub struct LlamaState(Mutex<Option<Child>>);

impl Drop for LlamaState {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.lock_ok().take() {
            let _ = c.kill();
        }
    }
}

#[tauri::command]
pub async fn llama_start(state: State<'_, LlamaState>, gguf_path: String, port: Option<u16>) -> Result<String> {
    if !std::path::Path::new(&gguf_path).is_file() {
        return err("The GGUF file was not found");
    }
    let bin = which::which("llama-server").map_err(|_| {
        AppError::Msg("llama-server was not found on your PATH. Install llama.cpp (for example `brew install llama.cpp`) or use Ollama / LM Studio.".into())
    })?;
    let port = port.unwrap_or(8080);
    let mut guard = state.0.lock_ok();
    if let Some(mut old) = guard.take() {
        let _ = old.kill();
    }
    let child = Command::new(bin)
        .args(["-m", &gguf_path, "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    *guard = Some(child);
    Ok(format!("http://127.0.0.1:{port}/v1"))
}

#[tauri::command]
pub async fn llama_stop(state: State<'_, LlamaState>) -> Result<()> {
    if let Some(mut c) = state.0.lock_ok().take() {
        let _ = c.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_openai_body() {
        let b = build_openai_body("m", "sys", "hi", true);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["content"], "hi");
        assert_eq!(b["response_format"]["type"], "json_object");
        assert!(build_openai_body("m", "s", "p", false).get("response_format").is_none());
    }

    #[test]
    fn builds_anthropic_body() {
        let b = build_anthropic_body("claude", "sys", "hi", 100);
        assert_eq!(b["system"], "sys");
        assert_eq!(b["max_tokens"], 100);
        assert_eq!(b["messages"][0]["role"], "user");
    }

    #[test]
    fn provider_catalog_is_consistent() {
        for p in PROVIDERS {
            assert!(p.base_url.starts_with("http"));
            assert!(p.protocol == "openai" || p.protocol == "anthropic");
        }
        assert!(provider("ollama").is_ok() && provider("nope").is_err());
    }
}
