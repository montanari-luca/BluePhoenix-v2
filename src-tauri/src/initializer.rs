//! Runs the plan of the "New project" wizard: scaffolding commands, small file edits, icon
//! generation and the git repository. The frontend builds the plan (see `src/lib/initializer.ts`);
//! this module executes it step by step and streams progress as `init-progress` events.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::error::{err, AppError, Result};
use crate::icons;

const STEP_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Default)]
pub struct InitState {
    runs: Mutex<HashMap<String, watch::Sender<bool>>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JsonEdit {
    /// Dotted path, e.g. `expo.ios.bundleIdentifier`.
    pub path: String,
    pub value: serde_json::Value,
}

/// `label` is shown by the frontend (it builds the step list), the runner does not need it.
#[allow(dead_code)]
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    /// Runs a program. `cwd` is `parent` (the folder the project is created in), `project`, or
    /// `project/<subfolder>`.
    #[serde(rename_all = "camelCase")]
    Run {
        label: String,
        program: String,
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        optional: bool,
        /// A path (relative to the project) that must exist afterwards; some scaffolders exit 0 on failure.
        #[serde(default)]
        expects: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Write { label: String, path: String, contents: String },
    #[serde(rename_all = "camelCase")]
    JsonSet {
        label: String,
        file: String,
        sets: Vec<JsonEdit>,
        #[serde(default)]
        optional: bool,
    },
    /// Replaces the first match of a regex in a file.
    #[serde(rename_all = "camelCase")]
    Replace {
        label: String,
        file: String,
        pattern: String,
        replacement: String,
        #[serde(default)]
        optional: bool,
    },
    #[serde(rename_all = "camelCase")]
    Icons { label: String, source: String, targets: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Git { label: String, message: String, branch: String, commit: bool },
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub run_id: String,
    pub parent: String,
    pub folder: String,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub start_at: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    run_id: &'a str,
    step: usize,
    /// start | ok | warn | error | log
    status: &'a str,
    line: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub ok: bool,
    pub cancelled: bool,
    pub path: String,
    pub failed_step: Option<usize>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub path: String,
    pub exists: bool,
    pub empty: bool,
    pub parent_exists: bool,
}

/// Receives (step, status, line) updates; the app forwards them as `init-progress` events.
type Sink = dyn Fn(usize, &str, Option<String>) + Send + Sync;

fn strip_ansi(s: &str) -> String {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07").unwrap());
    re.replace_all(s, "").to_string()
}

/// `rel` must stay inside `root`.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return err(format!("Path “{rel}” is outside the project"));
    }
    Ok(root.join(p))
}

fn set_json_path(root: &mut serde_json::Value, path: &str, value: serde_json::Value) {
    let mut cur = root;
    let parts: Vec<&str> = path.split('.').collect();
    for (i, key) in parts.iter().enumerate() {
        if !cur.is_object() {
            *cur = serde_json::json!({});
        }
        let obj = cur.as_object_mut().unwrap();
        if i == parts.len() - 1 {
            obj.insert((*key).to_string(), value);
            return;
        }
        cur = obj.entry((*key).to_string()).or_insert_with(|| serde_json::json!({}));
    }
}

fn apply_json(file: &Path, sets: &[JsonEdit]) -> Result<()> {
    let text = std::fs::read_to_string(file).map_err(|_| format!("{} does not exist", file.file_name().unwrap_or_default().to_string_lossy()))?;
    let mut json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Could not parse {}: {e}", file.display()))?;
    for s in sets {
        set_json_path(&mut json, &s.path, s.value.clone());
    }
    let mut out = serde_json::to_string_pretty(&json)?;
    out.push('\n');
    std::fs::write(file, out)?;
    Ok(())
}

fn apply_replace(file: &Path, pattern: &str, replacement: &str) -> Result<bool> {
    let text = std::fs::read_to_string(file).map_err(|_| format!("{} does not exist", file.file_name().unwrap_or_default().to_string_lossy()))?;
    let re = Regex::new(pattern).map_err(|e| format!("Bad pattern: {e}"))?;
    if !re.is_match(&text) {
        return Ok(false);
    }
    let out = re.replace(&text, regex::NoExpand(replacement)).to_string();
    std::fs::write(file, out)?;
    Ok(true)
}

fn resolve(program: &str) -> Result<PathBuf> {
    which::which(program)
        .map_err(|_| AppError::Msg(format!("“{program}” was not found. Install it and make sure it is on your PATH.")))
}

/// Runs a program and streams its output lines. Returns the exit success or an error message.
async fn run_program(
    sink: &Sink,
    step: usize,
    program: &str,
    args: &[String],
    cwd: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<bool> {
    let exe = resolve(program)?;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("npm_config_yes", "true")
        .env("npm_config_update_notifier", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {program}: {e}"))?;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut stream = stream;
            let mut buf = [0u8; 4096];
            let mut pending = String::new();
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                        // Progress bars redraw with \r; treat it like a line break.
                        while let Some(i) = pending.find(['\n', '\r']) {
                            let line: String = pending.drain(..=i).collect();
                            let line = strip_ansi(line.trim_end());
                            if !line.trim().is_empty() {
                                let _ = tx.send(line);
                            }
                        }
                    }
                }
            }
            let rest = strip_ansi(pending.trim());
            if !rest.is_empty() {
                let _ = tx.send(rest);
            }
        });
    }
    drop(tx);

    let deadline = tokio::time::sleep(STEP_TIMEOUT);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            line = rx.recv() => match line {
                Some(l) => sink(step, "log", Some(l)),
                None => break,
            },
            _ = cancel.changed() => {
                let _ = child.kill().await;
                return err("Cancelled");
            }
            _ = &mut deadline => {
                let _ = child.kill().await;
                return err(format!("{program} timed out after {} minutes", STEP_TIMEOUT.as_secs() / 60));
            }
        }
    }
    Ok(child.wait().await?.success())
}

async fn git(sink: &Sink, step: usize, root: &Path, args: &[&str], cancel: &mut watch::Receiver<bool>) -> Result<bool> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    run_program(sink, step, "git", &args, root, cancel).await
}

async fn git_output(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new(resolve("git").ok()?).args(args).current_dir(root).stdin(Stdio::null()).output().await.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

async fn run_step(
    sink: &Sink,
    i: usize,
    step: &Step,
    parent: &Path,
    root: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<String>> {
    match step {
        Step::Run { program, args, cwd, expects, .. } => {
            let dir = match cwd.as_deref() {
                None | Some("parent") => parent.to_path_buf(),
                Some("project") => root.to_path_buf(),
                Some(sub) => safe_join(root, sub.strip_prefix("project/").unwrap_or(sub))?,
            };
            std::fs::create_dir_all(&dir)?;
            if !run_program(sink, i, program, args, &dir, cancel).await? {
                return err(format!("{program} exited with an error"));
            }
            if let Some(rel) = expects {
                if !safe_join(root, rel)?.exists() {
                    return err(format!("{program} finished without creating {rel}. Check the log above for what it asked for."));
                }
            }
            Ok(None)
        }
        Step::Write { path, contents, .. } => {
            let p = safe_join(root, path)?;
            if let Some(d) = p.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::write(p, contents)?;
            Ok(None)
        }
        Step::JsonSet { file, sets, .. } => {
            apply_json(&safe_join(root, file)?, sets)?;
            Ok(None)
        }
        Step::Replace { file, pattern, replacement, .. } => {
            if apply_replace(&safe_join(root, file)?, pattern, replacement)? {
                Ok(None)
            } else {
                Ok(Some(format!("Nothing to change in {file}")))
            }
        }
        Step::Icons { source, targets, .. } => {
            let (source, root, targets) = (PathBuf::from(source), root.to_path_buf(), targets.clone());
            let wrote = tauri::async_runtime::spawn_blocking(move || icons::generate(&source, &root, &targets))
                .await
                .map_err(|e| e.to_string())??;
            for f in &wrote {
                sink(i, "log", Some(format!("wrote {f}")));
            }
            Ok(if wrote.is_empty() { Some("No icon locations found for this project type".into()) } else { None })
        }
        Step::Git { message, branch, commit, .. } => {
            std::fs::create_dir_all(root)?;
            if !root.join(".git").exists() {
                let ok = git(sink, i, root, &["init", "-b", branch], cancel).await?;
                if !ok {
                    // Git older than 2.28 has no -b.
                    if !git(sink, i, root, &["init"], cancel).await? {
                        return err("git init failed");
                    }
                }
            }
            if *commit {
                if !git(sink, i, root, &["add", "-A"], cancel).await? {
                    return err("git add failed");
                }
                let dirty = git_output(root, &["status", "--porcelain"]).await.unwrap_or_default();
                if dirty.trim().is_empty() {
                    return Ok(Some("Nothing to commit".into()));
                }
                if !git(sink, i, root, &["commit", "-m", message], cancel).await? {
                    return err("git commit failed. Set your name and email with git config --global user.name / user.email, then commit.");
                }
            }
            Ok(None)
        }
    }
}

fn step_optional(step: &Step) -> bool {
    match step {
        Step::Run { optional, .. } | Step::JsonSet { optional, .. } | Step::Replace { optional, .. } => *optional,
        // A missing icon location or a failed commit should not undo a working project.
        Step::Icons { .. } | Step::Git { .. } => true,
        Step::Write { .. } => false,
    }
}

async fn execute(plan: &Plan, sink: &Sink, cancel: &mut watch::Receiver<bool>) -> Result<InitResult> {
    let parent = PathBuf::from(&plan.parent);
    if plan.folder.is_empty() || plan.folder.contains(['/', '\\']) || plan.folder == ".." || plan.folder == "." {
        return err("Invalid project folder name");
    }
    std::fs::create_dir_all(&parent)?;
    let root = parent.join(&plan.folder);
    // Scaffolders refuse to create a folder that already exists, even an empty one.
    if plan.start_at == 0 && root.is_dir() {
        let _ = std::fs::remove_dir(&root);
    }

    let mut result = InitResult { ok: true, cancelled: false, path: root.to_string_lossy().to_string(), failed_step: None, error: None };
    for (i, step) in plan.steps.iter().enumerate().skip(plan.start_at) {
        sink(i, "start", None);
        match run_step(sink, i, step, &parent, &root, cancel).await {
            Ok(None) => sink(i, "ok", None),
            Ok(Some(note)) => sink(i, "warn", Some(note)),
            Err(e) => {
                let msg = e.to_string();
                if *cancel.borrow() || msg == "Cancelled" {
                    sink(i, "error", Some("Cancelled".into()));
                    result = InitResult { ok: false, cancelled: true, failed_step: Some(i), error: Some("Cancelled".into()), ..result };
                    break;
                }
                if step_optional(step) {
                    sink(i, "warn", Some(msg));
                    continue;
                }
                sink(i, "error", Some(msg.clone()));
                result = InitResult { ok: false, failed_step: Some(i), error: Some(msg), ..result };
                break;
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn init_run(app: AppHandle, state: State<'_, InitState>, plan: Plan) -> Result<InitResult> {
    let (tx, mut cancel) = watch::channel(false);
    state.runs.lock().unwrap().insert(plan.run_id.clone(), tx);
    let run_id = plan.run_id.clone();
    let sink = move |step: usize, status: &str, line: Option<String>| {
        let _ = app.emit("init-progress", Progress { run_id: &run_id, step, status, line });
    };
    let result = execute(&plan, &sink, &mut cancel).await;
    state.runs.lock().unwrap().remove(&plan.run_id);
    result
}

#[tauri::command]
pub fn init_cancel(state: State<'_, InitState>, run_id: String) {
    if let Some(tx) = state.runs.lock().unwrap().get(&run_id) {
        let _ = tx.send(true);
    }
}

/// Which of the programs are installed.
#[tauri::command]
pub fn init_tools(programs: Vec<String>) -> HashMap<String, bool> {
    programs.into_iter().map(|p| (p.clone(), which::which(&p).is_ok())).collect()
}

#[tauri::command]
pub fn init_preflight(parent: String, folder: String) -> Preflight {
    let parent_path = PathBuf::from(&parent);
    let path = parent_path.join(&folder);
    let exists = path.exists();
    let empty = path.read_dir().map(|mut d| d.next().is_none()).unwrap_or(true);
    Preflight { path: path.to_string_lossy().to_string(), exists, empty, parent_exists: parent_path.is_dir() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Manual end-to-end check: `BP_PLAN=/path/plan.json cargo test smoke -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn smoke() {
        let Ok(file) = std::env::var("BP_PLAN") else { return };
        let plan: Plan = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        let (_tx, mut cancel) = watch::channel(false);
        let sink = |step: usize, status: &str, line: Option<String>| {
            println!("[{step}] {status} {}", line.unwrap_or_default());
        };
        let r = execute(&plan, &sink, &mut cancel).await.unwrap();
        println!("RESULT ok={} failed={:?} err={:?} path={}", r.ok, r.failed_step, r.error, r.path);
        assert!(r.ok);
    }

    #[test]
    fn sets_nested_json_paths() {
        let mut v = json!({"expo": {"name": "a"}});
        set_json_path(&mut v, "expo.ios.bundleIdentifier", json!("com.x.y"));
        set_json_path(&mut v, "version", json!("1.2.3"));
        assert_eq!(v["expo"]["ios"]["bundleIdentifier"], "com.x.y");
        assert_eq!(v["expo"]["name"], "a");
        assert_eq!(v["version"], "1.2.3");
    }

    #[test]
    fn rejects_paths_outside_the_project() {
        let root = Path::new("/tmp/proj");
        assert!(safe_join(root, "../x").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
        assert!(safe_join(root, "src-tauri/Cargo.toml").is_ok());
    }

    #[test]
    fn replaces_only_the_first_version() {
        let dir = std::env::temp_dir().join(format!("bp-init-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("Cargo.toml");
        std::fs::write(&f, "[package]\nname = \"a\"\nversion = \"0.1.0\"\n[dependencies.x]\nversion = \"1\"\n").unwrap();
        assert!(apply_replace(&f, r#"(?m)^version\s*=\s*"[^"]*""#, r#"version = "2.0.0""#).unwrap());
        let text = std::fs::read_to_string(&f).unwrap();
        assert!(text.contains("version = \"2.0.0\"") && text.contains("version = \"1\""));
        assert!(!apply_replace(&f, "nomatch", "x").unwrap());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn strips_terminal_escapes() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m done"), "ok done");
    }
}
