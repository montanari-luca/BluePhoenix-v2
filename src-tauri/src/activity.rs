//! The dashboard's activity feed: what happened across all projects, newest first.
//!
//! Commits and fork updates are recorded in the local `activity` table as they are noticed. Automation
//! runs and completed to-dos already live in their own tables, so the feed reads those directly.
//! Commits are found by scanning each project's history since its last scan, triggered by the `.git`
//! watcher and by a periodic sweep. Branch switches and pulls of older commits therefore do not flood
//! the feed. Everything here is local to this computer.

use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{active_projects, now, Db};
use crate::error::{LockExt, Result};
use crate::git::exec;
use crate::scheduler::Job;

const DAY_MS: i64 = 86_400_000;
/// How far back the first scan of a project looks.
const BACKFILL_MS: i64 = 7 * DAY_MS;
/// Commits a few minutes older than the last scan still count (clock and timing slack).
const SLACK_MS: i64 = 5 * 60_000;
const KEEP_MS: i64 = 90 * DAY_MS;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    /// commit | fork | automation | todo
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
    /// ok | failed | warn, when the kind has one
    pub tone: Option<String>,
    pub ts: i64,
}

#[allow(clippy::too_many_arguments)]
pub fn record(db: &Db, id: &str, project_id: &str, kind: &str, title: &str, detail: Option<&str>, tone: Option<&str>, ts: i64) -> Result<bool> {
    let conn = db.0.lock_ok();
    let n = conn.execute(
        "INSERT OR IGNORE INTO activity(id,project_id,kind,title,detail,tone,ts) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![id, project_id, kind, title, detail, tone, ts],
    )?;
    Ok(n > 0)
}

/// One `git log` record: hash, short hash, author, commit time (s), subject.
fn parse_log(text: &str) -> Vec<(String, String, String, i64, String)> {
    text.split('\x1e')
        .filter_map(|rec| {
            let p: Vec<&str> = rec.trim_matches('\n').splitn(5, '\x1f').collect();
            if p.len() < 5 {
                return None;
            }
            Some((p[0].to_string(), p[1].to_string(), p[2].to_string(), p[3].parse().ok()?, p[4].trim().to_string()))
        })
        .collect()
}

/// Records commits on the current branch made since the last scan. Returns how many were new.
pub async fn scan_commits(db: &Db, project_id: &str, path: &str) -> Result<usize> {
    let t = now();
    let last: Option<i64> = {
        let conn = db.0.lock_ok();
        conn.query_row("SELECT last_scan FROM activity_scan WHERE project_id=?1", [project_id], |r| r.get(0)).optional()?
    };
    let since = last.map(|l| l - SLACK_MS).unwrap_or(t - BACKFILL_MS) / 1000;
    let since_arg = format!("--since=@{since}");
    let o = exec(path, &["log", "-n", "50", &since_arg, "--format=%H%x1f%h%x1f%an%x1f%ct%x1f%s%x1e"], 20).await?;
    let mut added = 0;
    if o.ok {
        for (hash, short, author, ct, subject) in parse_log(&o.stdout) {
            let id = format!("commit:{project_id}:{hash}");
            let detail = format!("{short} · {author}");
            if record(db, &id, project_id, "commit", &subject, Some(&detail), None, ct * 1000)? {
                added += 1;
            }
        }
    }
    let conn = db.0.lock_ok();
    conn.execute(
        "INSERT INTO activity_scan(project_id,last_scan) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET last_scan=?2",
        params![project_id, t],
    )?;
    Ok(added)
}

/// The feed, newest first. `before` pages back; `kinds` filters (empty = all).
pub fn feed(db: &Db, limit: i64, before: Option<i64>, kinds: &[String]) -> Result<Vec<Activity>> {
    let conn = db.0.lock_ok();
    let sql = "
        SELECT f.id, f.project_id, COALESCE(p.name, ''), f.kind, f.title, f.detail, f.tone, f.ts FROM (
          SELECT id, project_id, kind, title, detail, tone, ts FROM activity
          UNION ALL
          SELECT 'run:' || r.id, r.project_id, 'automation', COALESCE(a.name, 'Automation'),
                 CASE r.status WHEN 'ok' THEN 'Finished' WHEN 'timeout' THEN 'Timed out'
                   ELSE 'Failed' || COALESCE(' (exit ' || r.exit_code || ')', '') END,
                 CASE r.status WHEN 'ok' THEN 'ok' ELSE 'failed' END, r.finished_at
            FROM automation_runs r LEFT JOIN automations a ON a.id = r.automation_id
          UNION ALL
          SELECT 'todo:' || t.id, t.project_id, 'todo', t.title, 'Completed', 'ok', t.completed_at
            FROM todos t WHERE t.deleted = 0 AND t.status = 'done' AND t.completed_at IS NOT NULL
        ) f
        JOIN projects p ON p.id = f.project_id AND p.deleted = 0
        WHERE f.ts < ?1
        ORDER BY f.ts DESC
        LIMIT ?2";
    let mut stmt = conn.prepare(sql)?;
    // Filter in Rust: the list of kinds is tiny and this keeps the SQL static.
    let rows = stmt
        .query_map(params![before.unwrap_or(i64::MAX), if kinds.is_empty() { limit } else { limit * 20 }], |r| {
            Ok(Activity {
                id: r.get(0)?,
                project_id: r.get(1)?,
                project_name: r.get(2)?,
                kind: r.get(3)?,
                title: r.get(4)?,
                detail: r.get(5)?,
                tone: r.get(6)?,
                ts: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().filter(|a| kinds.is_empty() || kinds.contains(&a.kind)).take(limit as usize).collect())
}

fn prune(db: &Db) {
    let conn = db.0.lock_ok();
    let _ = conn.execute("DELETE FROM activity WHERE ts < ?1", [now() - KEEP_MS]);
}

async fn scan(app: &AppHandle, only: Option<&[String]>) {
    let db = app.state::<Db>();
    let projects = active_projects(&db).unwrap_or_default();
    let mut added = 0;
    for p in projects.iter().filter(|p| !p.project.path.is_empty()) {
        if only.is_some_and(|ids| !ids.contains(&p.project.id)) {
            continue;
        }
        added += scan_commits(&db, &p.project.id, &p.project.path).await.unwrap_or(0);
    }
    if added > 0 {
        let _ = app.emit("activity-changed", added);
    }
}

/// Called by the watcher with the projects whose git metadata just changed.
pub fn changed(app: &AppHandle, ids: &[String]) {
    let app = app.clone();
    let ids = ids.to_vec();
    tauri::async_runtime::spawn(async move { scan(&app, Some(&ids)).await });
}

pub fn jobs() -> Vec<Job> {
    vec![Job::every("activity", Duration::from_secs(15), Duration::from_secs(10 * 60), |app| async move {
        scan(&app, None).await;
        prune(&app.state::<Db>());
    })]
}

#[tauri::command]
pub async fn activity_feed(db: State<'_, Db>, limit: Option<i64>, before: Option<i64>, kinds: Option<Vec<String>>) -> Result<Vec<Activity>> {
    feed(&db, limit.unwrap_or(60).clamp(1, 500), before, &kinds.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn db() -> Db {
        Db::open(&std::env::temp_dir().join(format!("bp-activity-{}.db", uuid::Uuid::new_v4()))).unwrap()
    }

    fn git(dir: &std::path::Path, args: &[&str], date: Option<&str>) {
        let mut c = Command::new("git");
        c.arg("-C").arg(dir).args(["-c", "user.name=Ann", "-c", "user.email=a@a", "-c", "commit.gpgsign=false"]).args(args);
        if let Some(d) = date {
            c.env("GIT_COMMITTER_DATE", d).env("GIT_AUTHOR_DATE", d);
        }
        assert!(c.status().unwrap().success());
    }

    #[tokio::test]
    async fn scans_recent_commits_once_and_builds_the_feed() {
        let db = db();
        let dir = std::env::temp_dir().join(format!("bp-activity-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"], None);
        std::fs::write(dir.join("a"), "1").unwrap();
        git(&dir, &["add", "."], None);
        git(&dir, &["commit", "-q", "-m", "ancient"], Some("2001-01-01T00:00:00Z"));
        std::fs::write(dir.join("a"), "2").unwrap();
        git(&dir, &["commit", "-qam", "fresh work"], None);
        let t = now();
        {
            let c = db.0.lock_ok();
            c.execute("INSERT INTO projects(id,name,path,created_at,updated_at) VALUES('p','Proj',?1,1,1)", [dir.to_string_lossy()]).unwrap();
            c.execute(
                "INSERT INTO todos(id,project_id,title,status,created_at,completed_at,updated_at) VALUES('t','p','Ship it','done',1,?1,?1)",
                [t - 1000],
            )
            .unwrap();
            c.execute(
                "INSERT INTO automation_runs(id,automation_id,project_id,project_name,started_at,finished_at,status,exit_code)
                 VALUES('r','a','p','Proj',?1,?1,'failed',2)",
                [t - 2000],
            )
            .unwrap();
        }
        let path = dir.to_string_lossy().to_string();
        assert_eq!(scan_commits(&db, "p", &path).await.unwrap(), 1, "only the recent commit is backfilled");
        assert_eq!(scan_commits(&db, "p", &path).await.unwrap(), 0, "a rescan adds nothing");

        let f = feed(&db, 10, None, &[]).unwrap();
        let kinds: Vec<&str> = f.iter().map(|a| a.kind.as_str()).collect();
        assert!(kinds.contains(&"commit") && kinds.contains(&"todo") && kinds.contains(&"automation"));
        let run = f.iter().find(|a| a.kind == "automation").unwrap();
        assert_eq!(run.detail.as_deref(), Some("Failed (exit 2)"));
        assert_eq!(run.tone.as_deref(), Some("failed"));
        assert!(f.windows(2).all(|w| w[0].ts >= w[1].ts), "newest first");
        assert_eq!(f[0].project_name, "Proj");

        let only = feed(&db, 10, None, &["todo".into()]).unwrap();
        assert_eq!(only.len(), 1);
        let older = feed(&db, 10, Some(f[0].ts), &[]).unwrap();
        assert!(older.iter().all(|a| a.ts < f[0].ts));
    }

    #[test]
    fn parses_log_records() {
        let r = parse_log("h1\x1fs1\x1fAnn\x1f100\x1fHello\x1e\nh2\x1fs2\x1fBob\x1f200\x1fWorld\x1e\n");
        assert_eq!(r.len(), 2);
        assert_eq!(r[1], ("h2".into(), "s2".into(), "Bob".into(), 200, "World".into()));
    }
}
