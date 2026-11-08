//! Shares a short git summary per project through cloud sync, so the iPhone app can show the
//! branch, its state and recent commits. The phone never runs git. It only reads the `project_git` rows
//! this module writes.
//!
//! A row is rewritten only when something in it changed, so idle projects add no sync traffic.
//! Nothing is written while cloud sync is not connected.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::ai::secret_get;
use crate::db::{active_projects, now, Db};
use crate::error::{LockExt, Result};
use crate::git::{git_log, git_status};
use crate::scheduler::Job;
use crate::sync::URL_SECRET;

const COMMITS: u32 = 10;
/// Also catches edits to working files, which the `.git` watcher does not see.
const SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);

/// Whether cloud sync is connected, refreshed by the sweep (reading the keychain on every
/// watcher event would be wasteful).
static SHARING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SharedCommit {
    pub short: String,
    pub subject: String,
    pub author: String,
    pub ts: i64,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Summary {
    pub branch: Option<String>,
    pub state: String,
    pub ahead: i64,
    pub behind: i64,
    pub changed: i64,
    pub last_commit_ts: Option<i64>,
    pub last_commit_subject: Option<String>,
    /// JSON array of `SharedCommit`.
    pub commits: String,
}

async fn summarize(path: &str) -> Option<Summary> {
    let s = git_status(path.to_string()).await.ok()?;
    if !s.is_repo {
        return None;
    }
    let commits: Vec<SharedCommit> = git_log(path.to_string(), Some(COMMITS), None)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|c| SharedCommit { short: c.short, subject: c.subject, author: c.author, ts: c.ts })
        .collect();
    Some(Summary {
        branch: s.branch,
        state: s.state,
        ahead: s.ahead as i64,
        behind: s.behind as i64,
        changed: (s.staged + s.unstaged + s.untracked + s.conflicted) as i64,
        last_commit_ts: s.last_commit_ts,
        last_commit_subject: s.last_commit_subject,
        commits: serde_json::to_string(&commits).unwrap_or_else(|_| "[]".into()),
    })
}

fn stored(db: &Db, project_id: &str) -> Option<Summary> {
    let conn = db.0.lock_ok();
    conn.query_row(
        "SELECT branch,state,ahead,behind,changed,last_commit_ts,last_commit_subject,commits FROM project_git WHERE id=?1 AND deleted=0",
        [project_id],
        |r| {
            Ok(Summary {
                branch: r.get(0)?,
                state: r.get(1)?,
                ahead: r.get(2)?,
                behind: r.get(3)?,
                changed: r.get(4)?,
                last_commit_ts: r.get(5)?,
                last_commit_subject: r.get(6)?,
                commits: r.get(7)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// Writes the summary when it differs from what is stored. Returns whether it wrote.
pub fn store(db: &Db, project_id: &str, s: &Summary) -> Result<bool> {
    if stored(db, project_id).as_ref() == Some(s) {
        return Ok(false);
    }
    let conn = db.0.lock_ok();
    conn.execute(
        "INSERT INTO project_git(id,project_id,branch,state,ahead,behind,changed,last_commit_ts,last_commit_subject,commits,updated_at,deleted,dirty)
         VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,1)
         ON CONFLICT(id) DO UPDATE SET branch=?2,state=?3,ahead=?4,behind=?5,changed=?6,last_commit_ts=?7,
           last_commit_subject=?8,commits=?9,updated_at=?10,deleted=0,dirty=1",
        params![
            project_id, s.branch, s.state, s.ahead, s.behind, s.changed, s.last_commit_ts, s.last_commit_subject, s.commits,
            now()
        ],
    )?;
    Ok(true)
}

async fn snapshot(app: &AppHandle, project_id: &str, path: &str) {
    if let Some(s) = summarize(path).await {
        let _ = store(&app.state::<Db>(), project_id, &s);
    }
}

/// Called by the watcher with the projects whose git metadata just changed.
pub fn changed(app: &AppHandle, ids: &[String]) {
    if !SHARING.load(Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    let ids = ids.to_vec();
    tauri::async_runtime::spawn(async move {
        let projects = active_projects(&app.state::<Db>()).unwrap_or_default();
        for p in projects.into_iter().filter(|p| ids.contains(&p.project.id)) {
            snapshot(&app, &p.project.id, &p.project.path).await;
        }
    });
}

pub fn jobs() -> Vec<Job> {
    vec![Job::every("git summaries", Duration::from_secs(30), SWEEP_EVERY, |app| async move {
        let on = tauri::async_runtime::spawn_blocking(|| secret_get(URL_SECRET).is_some()).await.unwrap_or(false);
        SHARING.store(on, Ordering::Relaxed);
        if !on {
            return;
        }
        let projects = active_projects(&app.state::<Db>()).unwrap_or_default();
        for p in projects.into_iter().filter(|p| !p.project.path.is_empty()) {
            snapshot(&app, &p.project.id, &p.project.path).await;
        }
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open(&std::env::temp_dir().join(format!("bp-gitshare-{}.db", uuid::Uuid::new_v4()))).unwrap()
    }

    fn dirty(db: &Db) -> i64 {
        db.0.lock_ok().query_row("SELECT COUNT(*) FROM project_git WHERE dirty=1", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn writes_only_when_the_summary_changes() {
        let db = db();
        let s = Summary { branch: Some("main".into()), state: "clean".into(), commits: "[]".into(), ..Default::default() };
        assert!(store(&db, "p1", &s).unwrap());
        db.0.lock_ok().execute("UPDATE project_git SET dirty=0", []).unwrap();
        assert!(!store(&db, "p1", &s).unwrap(), "same summary must not be rewritten");
        assert_eq!(dirty(&db), 0);
        let s2 = Summary { changed: 3, state: "dirty".into(), ..s };
        assert!(store(&db, "p1", &s2).unwrap());
        assert_eq!(dirty(&db), 1);
    }

    #[tokio::test]
    async fn summarizes_a_real_repository() {
        use std::process::Command;
        let d = std::env::temp_dir().join(format!("bp-gitshare-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&d)
                .args(["-c", "user.name=Tess", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(d.join("a.txt"), "1").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "first commit"]);
        std::fs::write(d.join("b.txt"), "2").unwrap();
        let s = summarize(d.to_str().unwrap()).await.unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.changed, 1);
        assert_eq!(s.last_commit_subject.as_deref(), Some("first commit"));
        let commits: Vec<SharedCommit> = serde_json::from_str(&s.commits).unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].author, "Tess");
    }
}
