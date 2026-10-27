use std::path::PathBuf;

use futures_util::StreamExt;
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

use crate::error::{err, Result};

const VERSION_URL: &str =
    "https://raw.githubusercontent.com/montanari-luca/MintFlow-Releases/refs/heads/main/bluephoenix-v.json";
const DOWNLOAD_URL: &str =
    "https://raw.githubusercontent.com/montanari-luca/MintFlow-Releases/refs/heads/main/bluephoenix-d.json";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub download_url: Option<String>,
}

pub fn platform_key() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

pub fn parse_version(s: &str) -> Option<Version> {
    let t = s.trim().trim_start_matches('v');
    Version::parse(t).ok().or_else(|| {
        // Accept "0.2" style versions.
        let parts = t.split('.').count();
        if parts == 2 { Version::parse(&format!("{t}.0")).ok() } else { None }
    })
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().user_agent("BluePhoenix-Updater").timeout(std::time::Duration::from_secs(20)).build()?)
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let c = client()?;
    let v: serde_json::Value = c.get(VERSION_URL).send().await?.error_for_status()?.json().await?;
    let latest = v["latest"].as_str().ok_or("The version file has no \"latest\" field")?.to_string();
    let available = is_newer(&latest, &current);
    let mut download_url = None;
    if available {
        let d: serde_json::Value = c.get(DOWNLOAD_URL).send().await?.error_for_status()?.json().await?;
        download_url = d[platform_key()]
            .as_str()
            .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
            .map(String::from);
    }
    Ok(UpdateInfo { current, latest, available, download_url })
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn file_name_from(url: &str) -> String {
    let last = url.split(['?', '#']).next().unwrap_or(url).rsplit('/').next().unwrap_or("");
    if last.contains('.') && !last.is_empty() {
        last.to_string()
    } else {
        let ext = match platform_key() {
            "macos" => "dmg",
            "windows" => "exe",
            _ => "AppImage",
        };
        format!("BluePhoenix-update.{ext}")
    }
}

/// Downloads the installer into the user's Downloads folder, streaming progress events.
#[tauri::command]
pub async fn download_update(app: AppHandle, url: String) -> Result<String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return err("Invalid download link");
    }
    let dir: PathBuf = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let dest = dir.join(file_name_from(&url));
    let resp = reqwest::Client::builder()
        .user_agent("BluePhoenix-Updater")
        .build()?
        .get(&url)
        .send()
        .await?
        .error_for_status()?;
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(&dest).await?;
    let mut stream = resp.bytes_stream();
    let mut downloaded = 0u64;
    let mut last_emit = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 256 * 1024 {
            last_emit = downloaded;
            let _ = app.emit("update-progress", Progress { downloaded, total });
        }
    }
    file.flush().await?;
    let _ = app.emit("update-progress", Progress { downloaded, total });
    Ok(dest.to_string_lossy().to_string())
}

/// Opens the downloaded installer (or reveals it when it cannot be launched directly).
#[tauri::command]
pub async fn install_update(app: AppHandle, path: String) -> Result<()> {
    let lower = path.to_lowercase();
    if lower.ends_with(".appimage") {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        }
        app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())?;
    } else {
        app.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.3", "0.2.9"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn names_downloads() {
        assert_eq!(file_name_from("https://x.com/a/BluePhoenix_0.2.0.dmg?dl=1"), "BluePhoenix_0.2.0.dmg");
        assert!(file_name_from("https://x.com/download").starts_with("BluePhoenix-update."));
    }
}
