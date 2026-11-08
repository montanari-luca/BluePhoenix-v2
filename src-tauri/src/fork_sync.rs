//! GitHub forks: periodically fetch the upstream repository, report whether its new commits would
//! merge cleanly ("safe") or clash with local work ("conflicting"), and optionally merge them.
//!
//! Settings and the last result live in the local-only `fork_sync` table. The core (`check_project`)
//! only needs a `&Db`; `start_background` wires it to a scheduler loop, notifications and the
//! `fork-sync-finished` event the UI listens for.

use std::time::Duration;

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::db::{active_projects, list_projects, now, Db};
use crate::error::{err, Result};
use crate::git::exec;
use crate::scheduler::Job;

const MINUTE_MS: i64 = 60_000;
const MIN_INTERVAL_MINUTES: i64 = 15;
const DEFAULT_INTERVAL_MINUTES: i64 = 1440;
const LAUNCH_DELAY: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct ForkState {
    /// Checks never overlap: the scheduler, launch check and manual checks queue behind each other.
    lock: tokio::sync::Mutex<()>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForkSync {
    pub project_id: String,
    pub is_fork: bool,
    /// Name of the git remote that points at the original repository.
    pub upstream_remote: String,
    /// Added as `upstream_remote` when the remote does not exist yet.
    pub upstream_url: Option<String>,
    /// Branch to compare with; the current branch when empty.
    pub upstream_branch: Option<String>,
    pub auto_check: bool,
    pub interval_minutes: i64,
    pub auto_pull: bool,
    pub last_check: Option<i64>,
    pub last_pull: Option<i64>,
    /// up-to-date | safe | conflicting | pulled | unknown | error
    pub status: Option<String>,
    pub behind: i64,
    pub ahead: i64,
    pub message: Option<String>,
}

impl ForkSync {
    fn blank(project_id: &str) -> Self {
        ForkSync {
            project_id: project_id.to_string(),
            is_fork: false,
            upstream_remote: "upstream".into(),
            upstream_url: None,
            upstream_branch: None,
            auto_check: false,
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
            auto_pull: false,
            last_check: None,
            last_pull: None,
            status: None,
            behind: 0,
            ahead: 0,
            message: None,
        }
    }

    /// Whether the scheduler should check this project now.
    fn due(&self, t: i64) -> bool {
        self.is_fork
            && self.auto_check
            && self.last_check.is_none_or(|last| t - last >= self.interval_minutes.max(MIN_INTERVAL_MINUTES) * MINUTE_MS)
    }
}

fn from_row(r: &Row) -> rusqlite::Result<ForkSync> {
    Ok(ForkSync {
        project_id: r.get("project_id")?,
        is_fork: r.get("is_fork")?,
        upstream_remote: r.get("upstream_remote")?,
        upstream_url: r.get("upstream_url")?,
        upstream_branch: r.get("upstream_branch")?,
        auto_check: r.get("auto_check")?,
        interval_minutes: r.get("interval_minutes")?,
        auto_pull: r.get("auto_pull")?,
        last_check: r.get("last_check")?,
        last_pull: r.get("last_pull")?,
        status: r.get("status")?,
        behind: r.get("behind")?,
        ahead: r.get("ahead")?,
        message: r.get("message")?,
    })
}

fn load(db: &Db, project_id: &str) -> Result<ForkSync> {
    let conn = db.0.lock().unwrap();
    let found = conn
        .query_row("SELECT * FROM fork_sync WHERE project_id=?1 AND deleted=0", params![project_id], from_row)
        .optional()?;
    Ok(found.unwrap_or_else(|| ForkSync::blank(project_id)))
}

fn load_all(db: &Db) -> Result<Vec<ForkSync>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare("SELECT * FROM fork_sync WHERE is_fork=1 AND deleted=0")?;
    let rows = stmt.query_map([], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Saves the settings; the last result is kept (it is only ever written by a check).
fn save(db: &Db, mut cfg: ForkSync) -> Result<ForkSync> {
    cfg.upstream_remote = clean(Some(cfg.upstream_remote)).unwrap_or_else(|| "upstream".into());
    if cfg.upstream_remote.starts_with('-') || cfg.upstream_remote.contains(char::is_whitespace) {
        return err("That is not a valid remote name");
    }
    cfg.upstream_url = clean(cfg.upstream_url);
    cfg.upstream_branch = clean(cfg.upstream_branch);
    if cfg.upstream_branch.as_deref().is_some_and(|b| b.starts_with('-')) {
        return err("That is not a valid branch name");
    }
    cfg.interval_minutes = cfg.interval_minutes.max(MIN_INTERVAL_MINUTES);
    let conn = db.0.lock().unwrap();
    conn.execute(
        // The settings sync to other devices (see `sync.rs`); `id` mirrors `project_id` for the sync engine.
        "INSERT INTO fork_sync(id,project_id,is_fork,upstream_remote,upstream_url,upstream_branch,auto_check,interval_minutes,auto_pull,
           updated_at,deleted,dirty)
         VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,0,1)
         ON CONFLICT(project_id) DO UPDATE SET is_fork=?2,upstream_remote=?3,upstream_url=?4,upstream_branch=?5,
           auto_check=?6,interval_minutes=?7,auto_pull=?8,updated_at=?9,deleted=0,dirty=1",
        params![
            cfg.project_id, cfg.is_fork, cfg.upstream_remote, cfg.upstream_url, cfg.upstream_branch, cfg.auto_check,
            cfg.interval_minutes, cfg.auto_pull, now()
        ],
    )?;
    drop(conn);
    load(db, &cfg.project_id)
}

fn store_result(db: &Db, r: &ForkSync) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "UPDATE fork_sync SET last_check=?2,last_pull=?3,status=?4,behind=?5,ahead=?6,message=?7 WHERE project_id=?1",
        params![r.project_id, r.last_check, r.last_pull, r.status, r.behind, r.ahead, r.message],
    )?;
    Ok(())
}

fn project_path(db: &Db, project_id: &str) -> Result<String> {
    let found = list_projects(db)?.into_iter().find(|s| s.project.id == project_id);
    match found {
        Some(s) if !s.project.path.trim().is_empty() => Ok(s.project.path),
        Some(_) => err("This project has no folder"),
        None => err("Project not found"),
    }
}

/// What a check found, before it is turned into a stored result.
struct Outcome {
    status: &'static str,
    behind: i64,
    ahead: i64,
    pulled: bool,
    message: String,
}

fn fail(message: impl Into<String>) -> Outcome {
    Outcome { status: "error", behind: 0, ahead: 0, pulled: false, message: message.into() }
}

fn first_line(a: &str, b: &str) -> String {
    let text = if a.trim().is_empty() { b } else { a };
    text.trim().lines().next().unwrap_or("").to_string()
}

async fn run_check(path: &str, cfg: &ForkSync, pull: bool) -> Outcome {
    if !std::path::Path::new(path).is_dir() {
        return fail("Folder not found");
    }
    let remote = cfg.upstream_remote.as_str();

    // The remote may not exist yet (a fresh clone of the fork only has `origin`).
    let has_remote = exec(path, &["remote", "get-url", remote], 15).await.map(|o| o.ok).unwrap_or(false);
    if !has_remote {
        match cfg.upstream_url.as_deref() {
            Some(url) => match exec(path, &["remote", "add", remote, url], 15).await {
                Ok(o) if o.ok => {}
                Ok(o) => return fail(first_line(&o.stderr, &o.stdout)),
                Err(e) => return fail(e.to_string()),
            },
            None => {
                return fail(format!("No “{remote}” remote. Add one with git remote add {remote} <url>, or set the upstream URL."))
            }
        }
    }

    let branch = match exec(path, &["symbolic-ref", "--short", "-q", "HEAD"], 15).await {
        Ok(o) if o.ok && !o.stdout.trim().is_empty() => o.stdout.trim().to_string(),
        Ok(_) => return fail("HEAD is detached. Switch to a branch first."),
        Err(e) => return fail(e.to_string()),
    };

    match exec(path, &["fetch", "--prune", "--no-tags", remote], 180).await {
        Ok(o) if o.ok => {}
        Ok(o) => return fail(format!("Fetch failed: {}", first_line(&o.stderr, &o.stdout))),
        Err(e) => return fail(e.to_string()),
    }

    // Compare with the chosen branch; when none is chosen fall back from the current branch to main / master.
    let mut candidates: Vec<String> = match cfg.upstream_branch.as_deref() {
        Some(b) => vec![b.to_string()],
        None => vec![branch.clone(), "main".into(), "master".into()],
    };
    candidates.dedup();
    let mut target = None;
    for c in &candidates {
        let r = format!("refs/remotes/{remote}/{c}");
        if exec(path, &["rev-parse", "--verify", "-q", &r], 15).await.map(|o| o.ok).unwrap_or(false) {
            target = Some(r);
            break;
        }
    }
    let Some(target) = target else {
        return fail(format!("{remote} has no branch {}", candidates.join(" / ")));
    };
    let shown = target.trim_start_matches("refs/remotes/").to_string();

    let counts = exec(path, &["rev-list", "--left-right", "--count", &format!("HEAD...{target}")], 30).await;
    let (ahead, behind) = match counts {
        Ok(o) if o.ok => {
            let mut it = o.stdout.split_whitespace().map(|n| n.parse::<i64>().unwrap_or(0));
            (it.next().unwrap_or(0), it.next().unwrap_or(0))
        }
        Ok(o) => return fail(first_line(&o.stderr, &o.stdout)),
        Err(e) => return fail(e.to_string()),
    };
    if behind == 0 {
        let message = if ahead > 0 {
            format!("Up to date with {shown} ({ahead} local commit{} ahead).", plural(ahead))
        } else {
            format!("Up to date with {shown}.")
        };
        return Outcome { status: "up-to-date", behind, ahead, pulled: false, message };
    }

    // Would the merge conflict? merge-tree needs git 2.38+; exit code 1 means conflicts.
    let merge = exec(path, &["merge-tree", "--write-tree", "--no-messages", "HEAD", &target], 60).await;
    let (status, verdict) = match merge {
        Ok(o) if o.code == Some(0) => ("safe", "merges cleanly"),
        Ok(o) if o.code == Some(1) => ("conflicting", "conflicts with your changes"),
        _ => ("unknown", "could not be tested for conflicts (needs git 2.38 or newer)"),
    };
    let found = format!("{behind} new commit{} on {shown}", plural(behind));
    if status != "safe" || !pull {
        return Outcome { status, behind, ahead, pulled: false, message: format!("{found}; {verdict}.") };
    }

    // Pulling: only into a clean working tree, so nothing of the user's is ever touched.
    match exec(path, &["status", "--porcelain", "--untracked-files=no"], 30).await {
        Ok(o) if o.ok && o.stdout.trim().is_empty() => {}
        Ok(o) if o.ok => {
            return Outcome {
                status,
                behind,
                ahead,
                pulled: false,
                message: format!("{found}; {verdict}. Not pulled: you have uncommitted changes."),
            }
        }
        Ok(o) => return fail(first_line(&o.stderr, &o.stdout)),
        Err(e) => return fail(e.to_string()),
    }
    match exec(path, &["merge", "--no-edit", &target], 180).await {
        Ok(o) if o.ok => Outcome {
            status: "pulled",
            behind: 0,
            ahead,
            pulled: true,
            message: format!("Pulled {found}."),
        },
        Ok(o) => {
            // The pre-check said safe but the merge failed anyway: leave the repository as it was.
            let _ = exec(path, &["merge", "--abort"], 30).await;
            Outcome {
                status: "conflicting",
                behind,
                ahead,
                pulled: false,
                message: format!("{found}; the merge failed and was undone: {}", first_line(&o.stderr, &o.stdout)),
            }
        }
        Err(e) => fail(e.to_string()),
    }
}

fn plural(n: i64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// Checks one project now and stores the result. `pull` overrides the project's "pull automatically" setting.
pub async fn check_project(db: &Db, project_id: &str, pull: Option<bool>) -> Result<ForkSync> {
    let cfg = load(db, project_id)?;
    if !cfg.is_fork {
        return err("This project is not marked as a GitHub fork");
    }
    let path = project_path(db, project_id)?;
    let o = run_check(&path, &cfg, pull.unwrap_or(cfg.auto_pull)).await;
    let t = now();
    let result = ForkSync {
        last_check: Some(t),
        last_pull: if o.pulled { Some(t) } else { cfg.last_pull },
        status: Some(o.status.into()),
        behind: o.behind,
        ahead: o.ahead,
        message: Some(o.message),
        ..cfg
    };
    store_result(db, &result)?;
    Ok(result)
}

#[tauri::command]
pub async fn fork_get(db: State<'_, Db>, project_id: String) -> Result<ForkSync> {
    load(&db, &project_id)
}

#[tauri::command]
pub async fn fork_list(db: State<'_, Db>) -> Result<Vec<ForkSync>> {
    load_all(&db)
}

#[tauri::command]
pub async fn fork_save(db: State<'_, Db>, config: ForkSync) -> Result<ForkSync> {
    save(&db, config)
}

/// Manual "Check now" / "Pull now". Waits for a running scheduled check first.
#[tauri::command]
pub async fn fork_check(app: AppHandle, db: State<'_, Db>, project_id: String, pull: bool) -> Result<ForkSync> {
    let state = app.state::<ForkState>();
    let _lock = state.lock.lock().await;
    let result = check_project(&db, &project_id, Some(pull)).await?;
    let _ = app.emit("fork-sync-finished", vec![result.clone()]);
    Ok(result)
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Checks every fork that is due.
async fn run_due(app: &AppHandle) {
    let state = app.state::<ForkState>();
    let _lock = state.lock.lock().await;
    let db = app.state::<Db>();
    let t = now();
    let due: Vec<ForkSync> = load_all(&db).unwrap_or_default().into_iter().filter(|c| c.due(t)).collect();
    let mut results = vec![];
    for before in due {
        let name = active_projects(&db)
            .unwrap_or_default()
            .into_iter()
            .find(|s| s.project.id == before.project_id)
            .map(|s| s.project.name);
        let Some(name) = name else { continue };
        let Ok(after) = check_project(&db, &before.project_id, None).await else { continue };
        // Only speak up when something is new: a different status or more upstream commits.
        let news = after.status != before.status || after.behind > before.behind;
        if news {
            match after.status.as_deref() {
                Some("pulled") => notify(app, &name, after.message.as_deref().unwrap_or("Pulled upstream changes.")),
                Some("safe") => notify(app, &name, &format!("{} It is safe to pull.", after.message.as_deref().unwrap_or(""))),
                Some("conflicting") => notify(app, &name, after.message.as_deref().unwrap_or("Upstream changes conflict.")),
                _ => {}
            }
        }
        results.push(after);
    }
    if !results.is_empty() {
        let _ = app.emit("fork-sync-finished", results);
    }
}

/// For the shared scheduler: a check shortly after launch, then every minute for whatever has become due.
pub fn jobs() -> Vec<Job> {
    vec![Job::every("fork sync", LAUNCH_DELAY, TICK, |app| async move { run_due(&app).await })]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn commit(dir: &Path, file: &str, text: &str) {
        std::fs::write(dir.join(file), text).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-m", &format!("edit {file}")]);
    }

    /// An upstream repository and a fork cloned from it, plus a database with the fork registered.
    struct Fixture {
        root: PathBuf,
        upstream: PathBuf,
        fork: PathBuf,
        db: Db,
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("bp-fork-{}", uuid::Uuid::new_v4()));
        let upstream = root.join("upstream");
        let fork = root.join("fork");
        std::fs::create_dir_all(&upstream).unwrap();
        git(&upstream, &["init", "-b", "main"]);
        commit(&upstream, "a.txt", "one\n");
        git(&root, &["clone", upstream.to_str().unwrap(), "fork"]);
        let db = Db::open(&root.join("t.db")).unwrap();
        {
            let conn = db.0.lock().unwrap();
            conn.execute(
                "INSERT INTO projects(id,name,path,kind,created_at,updated_at) VALUES('p1','Fork',?1,'Other',1,1)",
                params![fork.to_str().unwrap()],
            )
            .unwrap();
        }
        save(
            &db,
            ForkSync {
                is_fork: true,
                auto_check: true,
                upstream_url: Some(upstream.to_str().unwrap().into()),
                ..ForkSync::blank("p1")
            },
        )
        .unwrap();
        Fixture { root, upstream, fork, db }
    }

    fn check(f: &Fixture, pull: Option<bool>) -> ForkSync {
        tauri::async_runtime::block_on(check_project(&f.db, "p1", pull)).unwrap()
    }

    #[test]
    fn due_follows_the_interval() {
        let mut c = ForkSync { is_fork: true, auto_check: true, interval_minutes: 60, ..ForkSync::blank("p") };
        assert!(c.due(1_000));
        c.last_check = Some(0);
        assert!(!c.due(59 * MINUTE_MS));
        assert!(c.due(60 * MINUTE_MS));
        c.auto_check = false;
        assert!(!c.due(10_000 * MINUTE_MS));
    }

    #[test]
    fn saving_clamps_the_interval_and_keeps_results() {
        let f = fixture();
        let url = Some(f.upstream.to_str().unwrap().to_string());
        let saved =
            save(&f.db, ForkSync { interval_minutes: 1, is_fork: true, upstream_url: url.clone(), ..ForkSync::blank("p1") }).unwrap();
        assert_eq!(saved.interval_minutes, MIN_INTERVAL_MINUTES);
        check(&f, None);
        let again = save(&f.db, ForkSync { is_fork: true, upstream_url: url, ..ForkSync::blank("p1") }).unwrap();
        assert_eq!(again.status.as_deref(), Some("up-to-date"));
        let _ = std::fs::remove_dir_all(&f.root);
    }

    #[test]
    fn adds_the_remote_and_reports_up_to_date() {
        let f = fixture();
        let r = check(&f, None);
        assert_eq!(r.status.as_deref(), Some("up-to-date"));
        assert_eq!(git(&f.fork, &["remote", "get-url", "upstream"]).trim(), f.upstream.to_str().unwrap());
        let _ = std::fs::remove_dir_all(&f.root);
    }

    #[test]
    fn safe_changes_are_reported_and_pulled_on_request() {
        let f = fixture();
        commit(&f.upstream, "b.txt", "new\n");
        let r = check(&f, Some(false));
        assert_eq!((r.status.as_deref(), r.behind), (Some("safe"), 1));
        assert!(!f.fork.join("b.txt").exists());
        let r = check(&f, Some(true));
        assert_eq!(r.status.as_deref(), Some("pulled"));
        assert!(f.fork.join("b.txt").exists());
        assert!(r.last_pull.is_some());
        let _ = std::fs::remove_dir_all(&f.root);
    }

    #[test]
    fn conflicts_are_flagged_and_never_pulled() {
        let f = fixture();
        commit(&f.upstream, "a.txt", "upstream\n");
        commit(&f.fork, "a.txt", "mine\n");
        let r = check(&f, Some(true));
        assert_eq!((r.status.as_deref(), r.behind, r.ahead), (Some("conflicting"), 1, 1));
        assert_eq!(std::fs::read_to_string(f.fork.join("a.txt")).unwrap(), "mine\n");
        assert!(git(&f.fork, &["status", "--porcelain"]).trim().is_empty());
        let _ = std::fs::remove_dir_all(&f.root);
    }

    #[test]
    fn uncommitted_changes_block_the_pull() {
        let f = fixture();
        commit(&f.upstream, "b.txt", "new\n");
        std::fs::write(f.fork.join("a.txt"), "dirty\n").unwrap();
        let r = check(&f, Some(true));
        assert_eq!(r.status.as_deref(), Some("safe"));
        assert!(r.message.unwrap().contains("uncommitted"));
        assert!(!f.fork.join("b.txt").exists());
        let _ = std::fs::remove_dir_all(&f.root);
    }

    #[test]
    fn missing_remote_without_url_is_an_error() {
        let f = fixture();
        save(&f.db, ForkSync { is_fork: true, upstream_remote: "nope".into(), ..ForkSync::blank("p1") }).unwrap();
        let r = check(&f, None);
        assert_eq!(r.status.as_deref(), Some("error"));
        let _ = std::fs::remove_dir_all(&f.root);
    }
}
