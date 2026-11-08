//! Which projects an automation runs in, and the requisites they must meet.

use super::*;

pub fn resolve_targets(db: &Db, a: &Automation) -> Result<Vec<Project>> {
    Ok(active_projects(db)?
        .into_iter()
        .map(|s| s.project)
        .filter(|p| !p.path.is_empty() && Path::new(&p.path).is_dir())
        .filter(|p| match a.target_mode.as_str() {
            "all" => a.kind_filter.as_deref().is_none_or(|k| p.kind.eq_ignore_ascii_case(k)),
            _ => a.project_ids.contains(&p.id),
        })
        .collect())
}

/// True when any file (outside .git, node_modules and ignored paths) changed within `window`.
pub fn edited_within(root: &Path, window: Duration) -> bool {
    let Some(cutoff) = std::time::SystemTime::now().checked_sub(window) else { return false };
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git" && e.file_name() != "node_modules")
        .build();
    for (seen, e) in walker.flatten().enumerate() {
        if seen >= MAX_WALK {
            break;
        }
        if !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if e.metadata().ok().and_then(|m| m.modified().ok()).is_some_and(|t| t > cutoff) {
            return true;
        }
    }
    false
}

/// Why the project must be skipped, or `None` when every requisite holds.
pub(super) async fn unmet_requisite(a: &Automation, p: &Project) -> Option<String> {
    let dir = Path::new(&p.path);
    if (a.require_git_repo || a.require_clean_git) && !dir.join(".git").exists() {
        return Some("not a git repository".into());
    }
    if a.require_clean_git {
        match git_porcelain(&p.path).await {
            Ok(s) if s.trim().is_empty() => {}
            Ok(_) => return Some("uncommitted changes".into()),
            Err(e) => return Some(format!("git status failed: {e}")),
        }
    }
    if let Some(h) = a.idle_hours {
        let root = dir.to_path_buf();
        let window = Duration::from_secs(h as u64 * 3600);
        let busy = tokio::task::spawn_blocking(move || edited_within(&root, window)).await.unwrap_or(false);
        if busy {
            return Some(format!("edited in the last {h}h"));
        }
    }
    None
}

pub(super) async fn git_porcelain(path: &str) -> std::result::Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", path, "status", "--porcelain"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
