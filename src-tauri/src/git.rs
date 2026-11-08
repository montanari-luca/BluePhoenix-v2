use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::error::{err, Result};

const MAX_TEXT: usize = 200_000;

pub(crate) struct Out {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub(crate) async fn exec(path: &str, args: &[&str], timeout_s: u64) -> Result<Out> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git was not found. Install Git and make sure it is on your PATH.".to_string()
        } else {
            e.to_string()
        }
    })?;
    let output = tokio::time::timeout(Duration::from_secs(timeout_s), child.wait_with_output())
        .await
        .map_err(|_| format!("git {} timed out after {timeout_s}s", args.first().unwrap_or(&"")))??;
    Ok(Out {
        ok: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// Runs git and returns stdout; on failure returns the error text.
async fn run(path: &str, args: &[&str]) -> Result<String> {
    let o = exec(path, args, 60).await?;
    if o.ok {
        Ok(o.stdout)
    } else {
        err(first_nonempty(&o.stderr, &o.stdout))
    }
}

/// For actions the user wants feedback on (push, pull, merge ...): stdout + stderr.
async fn act(path: &str, args: &[&str], timeout_s: u64) -> Result<String> {
    let o = exec(path, args, timeout_s).await?;
    let combined = format!("{}{}", o.stdout, o.stderr).trim().to_string();
    if o.ok {
        Ok(if combined.is_empty() { "Done.".into() } else { combined })
    } else {
        err(if combined.is_empty() { "git command failed".into() } else { combined })
    }
}

fn first_nonempty(a: &str, b: &str) -> String {
    let a = a.trim();
    if a.is_empty() { b.trim().to_string() } else { a.to_string() }
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… (truncated)");
    }
    s
}

// ---------- status ----------

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub changes: Vec<Change>,
    pub stash_count: u32,
    pub last_commit_ts: Option<i64>,
    pub last_commit_subject: Option<String>,
    pub remote_url: Option<String>,
    /// no-repo | conflict | dirty | diverged | ahead | behind | no-upstream | clean
    pub state: String,
}

pub fn parse_status(text: &str) -> GitStatus {
    let mut s = GitStatus { is_repo: true, ..Default::default() };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            let mut it = rest.splitn(2, ' ');
            match (it.next(), it.next()) {
                (Some("branch.head"), Some(v)) => {
                    if v == "(detached)" {
                        s.detached = true;
                    } else {
                        s.branch = Some(v.to_string());
                    }
                }
                (Some("branch.oid"), Some(v)) if v != "(initial)" => {
                    s.head = Some(v.chars().take(7).collect());
                }
                (Some("branch.upstream"), Some(v)) => s.upstream = Some(v.to_string()),
                (Some("branch.ab"), Some(v)) => {
                    for part in v.split_whitespace() {
                        if let Some(a) = part.strip_prefix('+') {
                            s.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = part.strip_prefix('-') {
                            s.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = line.chars().next().unwrap_or(' ');
        match kind {
            '1' | '2' | 'u' => {
                let (nsplit, path_idx) = match kind {
                    '1' => (9, 8),
                    '2' => (10, 9),
                    _ => (11, 10),
                };
                let parts: Vec<&str> = line.splitn(nsplit, ' ').collect();
                if parts.len() <= path_idx {
                    continue;
                }
                let xy: Vec<char> = parts[1].chars().collect();
                let (x, y) = (xy.first().copied().unwrap_or('.'), xy.get(1).copied().unwrap_or('.'));
                let path = parts[path_idx].split('\t').next().unwrap_or("").to_string();
                if kind == 'u' {
                    s.conflicted += 1;
                } else {
                    if x != '.' {
                        s.staged += 1;
                    }
                    if y != '.' {
                        s.unstaged += 1;
                    }
                }
                s.changes.push(Change {
                    path,
                    index: x.to_string(),
                    worktree: y.to_string(),
                    untracked: false,
                    conflicted: kind == 'u',
                });
            }
            '?' => {
                s.untracked += 1;
                s.changes.push(Change {
                    path: line[2..].to_string(),
                    index: "?".into(),
                    worktree: "?".into(),
                    untracked: true,
                    conflicted: false,
                });
            }
            _ => {}
        }
    }
    s.state = if s.conflicted > 0 {
        "conflict"
    } else if s.staged + s.unstaged + s.untracked > 0 {
        "dirty"
    } else if s.ahead > 0 && s.behind > 0 {
        "diverged"
    } else if s.ahead > 0 {
        "ahead"
    } else if s.behind > 0 {
        "behind"
    } else if s.upstream.is_none() && !s.detached {
        "no-upstream"
    } else {
        "clean"
    }
    .into();
    s
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus> {
    if !std::path::Path::new(&path).is_dir() {
        return err("Folder not found");
    }
    let st = exec(&path, &["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"], 30).await?;
    if !st.ok {
        return Ok(GitStatus { is_repo: false, state: "no-repo".into(), ..Default::default() });
    }
    let (log, stash, remote) = tokio::join!(
        exec(&path, &["log", "-1", "--format=%ct%x1f%s"], 15),
        exec(&path, &["stash", "list"], 15),
        exec(&path, &["remote", "get-url", "origin"], 15),
    );
    let mut s = parse_status(&st.stdout);
    if let Ok(l) = log {
        if l.ok {
            let mut it = l.stdout.trim().splitn(2, '\x1f');
            s.last_commit_ts = it.next().and_then(|v| v.parse::<i64>().ok()).map(|v| v * 1000);
            s.last_commit_subject = it.next().map(|v| v.to_string());
        }
    }
    if let Ok(l) = stash {
        s.stash_count = l.stdout.lines().count() as u32;
    }
    if let Ok(r) = remote {
        if r.ok {
            s.remote_url = Some(r.stdout.trim().to_string());
        }
    }
    Ok(s)
}

// ---------- branches ----------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
    pub last_commit_ts: Option<i64>,
    pub subject: String,
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<Branch>> {
    let out = run(
        &path,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:unix)%1f%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .await?;
    let mut v = vec![];
    for line in out.lines() {
        let p: Vec<&str> = line.split('\x1f').collect();
        if p.len() < 6 || p[0].ends_with("/HEAD") {
            continue;
        }
        v.push(Branch {
            name: p[1].to_string(),
            current: p[2] == "*",
            remote: p[0].starts_with("refs/remotes/"),
            upstream: if p[3].is_empty() { None } else { Some(p[3].to_string()) },
            last_commit_ts: p[4].parse::<i64>().ok().map(|t| t * 1000),
            subject: p[5].to_string(),
        });
    }
    Ok(v)
}

#[tauri::command]
pub async fn git_tags(path: String) -> Result<Vec<String>> {
    let out = run(&path, &["tag", "--sort=-creatordate"]).await.unwrap_or_default();
    Ok(out.lines().take(40).map(|s| s.to_string()).collect())
}

// ---------- log / diff ----------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub ts: i64,
    pub subject: String,
    pub body: String,
    /// Full hashes of the parent commits (empty for a root commit).
    pub parents: Vec<String>,
    /// Ref decorations pointing at this commit, as git prints them
    /// (e.g. `HEAD -> main`, `origin/main`, `tag: v1.0`).
    pub refs: Vec<String>,
}

const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%ct%x1f%P%x1f%D%x1f%s%x1f%b%x1e";

/// Parses the output of `git log` run with [`LOG_FORMAT`].
pub fn parse_log(text: &str) -> Vec<Commit> {
    text.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            let p: Vec<&str> = rec.splitn(8, '\x1f').collect();
            if p.len() < 7 {
                return None;
            }
            Some(Commit {
                hash: p[0].to_string(),
                short: p[1].to_string(),
                author: p[2].to_string(),
                ts: p[3].parse::<i64>().unwrap_or(0) * 1000,
                parents: p[4].split_whitespace().map(str::to_string).collect(),
                refs: p[5].split(", ").map(str::trim).filter(|r| !r.is_empty()).map(str::to_string).collect(),
                subject: p[6].to_string(),
                body: p.get(7).unwrap_or(&"").trim().to_string(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_log(path: String, limit: Option<u32>, range: Option<String>) -> Result<Vec<Commit>> {
    let n = limit.unwrap_or(50).to_string();
    // --date-order guarantees children are listed before their parents,
    // which the history graph relies on.
    let mut args: Vec<&str> = vec!["log", "--date-order", "-n", &n, LOG_FORMAT];
    let range_s;
    if let Some(r) = range.as_ref().filter(|r| !r.trim().is_empty()) {
        range_s = r.clone();
        args.push(&range_s);
    }
    let o = exec(&path, &args, 30).await?;
    if !o.ok {
        // Empty repository: no commits yet.
        if o.stderr.contains("does not have any commits") {
            return Ok(vec![]);
        }
        return err(first_nonempty(&o.stderr, &o.stdout));
    }
    Ok(parse_log(&o.stdout))
}

#[tauri::command]
pub async fn git_diff(path: String, staged: bool, file: Option<String>) -> Result<String> {
    let mut args = vec!["diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    let f;
    if let Some(file) = file {
        f = file;
        args.push("--");
        args.push(&f);
    }
    Ok(truncate(run(&path, &args).await?))
}

#[tauri::command]
pub async fn git_show(path: String, hash: String) -> Result<String> {
    Ok(truncate(run(&path, &["show", "--no-color", "--stat", "--patch", &hash]).await?))
}

// ---------- actions ----------

#[tauri::command]
pub async fn git_fetch(path: String) -> Result<String> {
    act(&path, &["fetch", "--all", "--prune"], 180).await
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<String> {
    act(&path, &["pull"], 180).await
}

/// Pull that never creates a merge commit: fails instead when the branches have diverged.
#[tauri::command]
pub async fn git_pull_ff(path: String) -> Result<String> {
    act(&path, &["pull", "--ff-only"], 180).await
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<String> {
    let has_upstream =
        exec(&path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 15).await?.ok;
    if has_upstream {
        act(&path, &["push"], 180).await
    } else {
        act(&path, &["push", "-u", "origin", "HEAD"], 180).await
    }
}

#[tauri::command]
pub async fn git_stash(path: String, message: Option<String>) -> Result<String> {
    let m = message.unwrap_or_else(|| "BluePhoenix stash".into());
    act(&path, &["stash", "push", "--include-untracked", "-m", &m], 60).await
}

#[tauri::command]
pub async fn git_stash_apply(path: String) -> Result<String> {
    act(&path, &["stash", "apply"], 60).await
}

#[tauri::command]
pub async fn git_stash_list(path: String) -> Result<Vec<String>> {
    Ok(run(&path, &["stash", "list"]).await?.lines().map(|l| l.to_string()).collect())
}

#[tauri::command]
pub async fn git_checkout(path: String, name: String, remote: bool) -> Result<String> {
    if remote {
        act(&path, &["checkout", "--track", &name], 60).await
    } else {
        act(&path, &["checkout", &name], 60).await
    }
}

#[tauri::command]
pub async fn git_create_branch(path: String, name: String, from: Option<String>) -> Result<String> {
    let mut args = vec!["checkout", "-b", &name];
    let f;
    if let Some(from) = from.filter(|f| !f.is_empty()) {
        f = from;
        args.push(&f);
    }
    act(&path, &args, 60).await
}

#[tauri::command]
pub async fn git_delete_branch(path: String, name: String, force: bool) -> Result<String> {
    act(&path, &["branch", if force { "-D" } else { "-d" }, &name], 60).await
}

#[tauri::command]
pub async fn git_merge(path: String, name: String) -> Result<String> {
    act(&path, &["merge", &name], 120).await
}

#[tauri::command]
pub async fn git_merge_abort(path: String) -> Result<String> {
    act(&path, &["merge", "--abort"], 30).await
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<()> {
    if files.is_empty() {
        run(&path, &["add", "-A"]).await?;
    } else {
        let mut args = vec!["add", "--"];
        args.extend(files.iter().map(|s| s.as_str()));
        run(&path, &args).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<()> {
    let mut args = vec!["restore", "--staged", "--"];
    if files.is_empty() {
        args.push(".");
    } else {
        args.extend(files.iter().map(|s| s.as_str()));
    }
    run(&path, &args).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_commit(app: tauri::AppHandle, path: String, message: String) -> Result<String> {
    if message.trim().is_empty() {
        return err("Commit message is empty");
    }
    let out = act(&path, &["commit", "-m", &message], 60).await?;
    crate::automation_runtime::after_commit(&app, &path);
    Ok(out)
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<String> {
    act(&path, &["init"], 30).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_tracking_branch() {
        let s = parse_status("# branch.oid abcdef1234\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.state, "clean");
        assert_eq!(s.head.as_deref(), Some("abcdef1"));
    }

    #[test]
    fn parses_ahead_behind_and_dirty() {
        let s = parse_status("# branch.head dev\n# branch.upstream origin/dev\n# branch.ab +2 -3\n");
        assert_eq!((s.ahead, s.behind), (2, 3));
        assert_eq!(s.state, "diverged");
        let s = parse_status("# branch.head dev\n# branch.upstream origin/dev\n# branch.ab +0 -0\n1 .M N... 100644 100644 100644 a b src/a.rs\n? new.txt\n");
        assert_eq!(s.state, "dirty");
        assert_eq!((s.unstaged, s.untracked, s.staged), (1, 1, 0));
        assert_eq!(s.changes[0].path, "src/a.rs");
    }

    #[test]
    fn parses_rename_conflict_and_no_upstream() {
        let s = parse_status("# branch.head x\n2 R. N... 100644 100644 100644 a b R100 new.rs\told.rs\nu UU N... 1 2 3 4 a b c conflict.rs\n");
        assert_eq!(s.changes[0].path, "new.rs");
        assert_eq!(s.conflicted, 1);
        assert_eq!(s.state, "conflict");
        let s = parse_status("# branch.oid (initial)\n# branch.head main\n");
        assert_eq!(s.state, "no-upstream");
        assert!(s.head.is_none());
    }

    #[test]
    fn parses_log_parents_and_refs() {
        let out = "aaa\x1fa\x1fAnn\x1f10\x1fbbb ccc\x1fHEAD -> main, origin/main, tag: v1\x1fMerge\x1f\x1e\n\
                   bbb\x1fb\x1fBo\x1f5\x1f\x1f\x1fRoot\x1fline1\nline2\n\x1e\n";
        let c = parse_log(out);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(c[0].refs, vec!["HEAD -> main", "origin/main", "tag: v1"]);
        assert_eq!(c[0].ts, 10_000);
        assert_eq!(c[0].subject, "Merge");
        assert!(c[1].parents.is_empty() && c[1].refs.is_empty());
        assert_eq!(c[1].body, "line1\nline2");
    }
}
