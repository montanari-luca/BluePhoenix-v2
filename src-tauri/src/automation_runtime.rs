//! Connects the automations engine to the running app: launch / schedule / commit / quit triggers,
//! system notifications and the `automation-finished` event the UI listens for.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::automations::{self, RunOpts, RunSummary};
use crate::db::{list_projects, now, Db};
use crate::error::{LockExt, Result};
use crate::scheduler::Job;

const LAUNCH_DELAY: Duration = Duration::from_secs(5);
const TICK: Duration = Duration::from_secs(60);
const QUIT_BUDGET: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct AutomationState {
    /// Runs never overlap: launch, ticks, commits and manual runs queue behind each other.
    run_lock: tokio::sync::Mutex<()>,
    /// (automation id, due time) pairs whose "before" alert already fired.
    announced: Mutex<HashSet<(String, i64)>>,
    quitting: AtomicBool,
    /// Last seen (branch, HEAD, upstream) per project, to tell branch switches and pushes apart.
    git_seen: Mutex<HashMap<String, GitSeen>>,
    /// When a file-change automation last finished per project: changes right after are its own output.
    files_quiet_until: Mutex<HashMap<String, Instant>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitSeen {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
}

/// What changed between two looks at a repository.
pub fn git_events(before: &GitSeen, after: &GitSeen) -> Vec<(&'static str, String)> {
    let mut out = vec![];
    if let (Some(a), Some(b)) = (&before.branch, &after.branch)
        && a != b
    {
        out.push(("branch", b.clone()));
    }
    // A push moves the upstream ref onto our (unchanged) HEAD. A fetch moves it elsewhere; a
    // pull moves HEAD too. Neither counts.
    let same_branch = before.branch == after.branch;
    if same_branch && after.head.is_some() && before.head == after.head && before.upstream != after.upstream && after.upstream == after.head {
        out.push(("push", after.branch.clone().unwrap_or_default()));
    }
    out
}

/// After a file-change automation runs, ignore changes for this long (they are most likely its output).
const FILES_QUIET: Duration = Duration::from_secs(10);

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn describe(s: &RunSummary) -> String {
    let n = s.ran();
    let projects = if n == 1 { "1 project".to_string() } else { format!("{n} projects") };
    if s.failed == 0 {
        format!("Ran on {projects}.")
    } else {
        format!("{} succeeded, {} failed ({projects}).", s.ok, s.failed)
    }
}

fn report(app: &AppHandle, summaries: &[RunSummary]) {
    let ran: Vec<&RunSummary> = summaries.iter().filter(|s| s.ran() > 0).collect();
    for s in &ran {
        if s.notify == "on_run" {
            notify(app, &s.name, &describe(s));
        } else if s.failed > 0 {
            // Failures are worth knowing about even when the automation is otherwise quiet.
            crate::notify::send(app, crate::notify::AUTOMATION_FAILED, &format!("{} failed", s.name), &describe(s));
        }
    }
    if !ran.is_empty() {
        let _ = app.emit("automation-finished", summaries);
    }
}

async fn run_trigger_and_report(app: &AppHandle, trigger: &str, project_id: Option<&str>, deadline: Option<Instant>) {
    let state = app.state::<AutomationState>();
    let _lock = state.run_lock.lock().await;
    let sums = automations::run_trigger(&app.state::<Db>(), trigger, project_id, deadline).await;
    report(app, &sums);
}

/// Sends the "before" alert once per upcoming run of scheduled automations.
fn announce_upcoming(app: &AppHandle) {
    let db = app.state::<Db>();
    let state = app.state::<AutomationState>();
    let t = now();
    for a in automations::list_automations(&db).unwrap_or_default() {
        if !a.enabled || a.trigger != "schedule" || a.notify != "before" {
            continue;
        }
        let Some(mins) = a.notify_before_min else { continue };
        let Some(due) = automations::soonest_due(&db, &a) else { continue };
        if due == i64::MIN || due <= t || t < due - mins * 60_000 {
            continue;
        }
        if state.announced.lock_ok().insert((a.id.clone(), due)) {
            let left = ((due - t) as f64 / 60_000.0).ceil() as i64;
            notify(app, &a.name, &format!("Runs in {left} min."));
        }
    }
}

/// The launch run and the schedule tick, for the shared scheduler.
pub fn jobs() -> Vec<Job> {
    vec![
        Job::once("automations: launch", LAUNCH_DELAY, |app| async move {
            run_trigger_and_report(&app, "launch", None, None).await;
        }),
        Job::every("automations: schedule", LAUNCH_DELAY, TICK, |app| async move {
            run_trigger_and_report(&app, "schedule", None, None).await;
            announce_upcoming(&app);
            prime_git_seen(&app).await;
        }),
    ]
}

/// Runs the event automations of `trigger` in one project and reports them.
pub fn on_event(app: &AppHandle, trigger: &'static str, project_id: &str, values: Vec<String>) {
    let app = app.clone();
    let project_id = project_id.to_string();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AutomationState>();
        let _lock = state.run_lock.lock().await;
        let sums = automations::run_event(&app.state::<Db>(), trigger, &project_id, &values).await;
        if trigger == "files" && !sums.is_empty() {
            state.files_quiet_until.lock_ok().insert(project_id.clone(), Instant::now() + FILES_QUIET);
        }
        report(&app, &sums);
    });
}

/// Files changed in a project's working tree (paths relative to it, with `/`).
pub fn on_files(app: &AppHandle, project_id: &str, paths: Vec<String>) {
    let state = app.state::<AutomationState>();
    if state.run_lock.try_lock().is_err() {
        return; // an automation is running; its own writes must not start another
    }
    if state.files_quiet_until.lock_ok().get(project_id).is_some_and(|t| Instant::now() < *t) {
        return;
    }
    on_event(app, "files", project_id, paths);
}

async fn look(path: &str) -> GitSeen {
    let head_file = std::fs::read_to_string(std::path::Path::new(path).join(".git/HEAD")).ok();
    let branch = match head_file.as_deref().and_then(|h| h.trim().strip_prefix("ref: refs/heads/")) {
        Some(b) => Some(b.to_string()),
        None => crate::git::exec(path, &["symbolic-ref", "--short", "-q", "HEAD"], 10)
            .await
            .ok()
            .filter(|o| o.ok)
            .map(|o| o.stdout.trim().to_string())
            .filter(|b| !b.is_empty()),
    };
    let rev = |r: &'static str| async move {
        crate::git::exec(path, &["rev-parse", "-q", "--verify", r], 10).await.ok().filter(|o| o.ok).map(|o| o.stdout.trim().to_string())
    };
    let (head, upstream) = tokio::join!(rev("HEAD"), rev("@{u}"));
    GitSeen { branch, head, upstream }
}

/// Called by the watcher: detects branch switches and pushes for projects that have such automations.
pub fn on_git_changed(app: &AppHandle, ids: &[String]) {
    let app = app.clone();
    let ids = ids.to_vec();
    tauri::async_runtime::spawn(async move {
        let db = app.state::<Db>();
        let wanted: HashSet<String> =
            ["branch", "push"].iter().flat_map(|t| automations::watched_projects(&db, t)).collect();
        if wanted.is_empty() {
            return;
        }
        let projects = list_projects(&db).unwrap_or_default();
        for p in projects.into_iter().filter(|p| ids.contains(&p.project.id) && wanted.contains(&p.project.id)) {
            let now_seen = look(&p.project.path).await;
            let before = app.state::<AutomationState>().git_seen.lock_ok().insert(p.project.id.clone(), now_seen.clone());
            let Some(before) = before else { continue }; // first look: just remember
            for (trigger, value) in git_events(&before, &now_seen) {
                on_event(&app, trigger, &p.project.id, vec![value]);
            }
        }
    });
}

/// Primes the remembered git state so the first change after launch is recognised.
pub async fn prime_git_seen(app: &AppHandle) {
    let db = app.state::<Db>();
    let wanted: HashSet<String> = ["branch", "push"].iter().flat_map(|t| automations::watched_projects(&db, t)).collect();
    for p in list_projects(&db).unwrap_or_default().into_iter().filter(|p| wanted.contains(&p.project.id)) {
        let seen = look(&p.project.path).await;
        app.state::<AutomationState>().git_seen.lock_ok().entry(p.project.id).or_insert(seen);
    }
}

/// Called after a commit made through BluePhoenix succeeded in `path`.
pub fn after_commit(app: &AppHandle, path: &str) {
    let app = app.clone();
    let path = path.to_string();
    tauri::async_runtime::spawn(async move {
        let same = |a: &str, b: &str| match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => a == b,
        };
        let id = list_projects(&app.state::<Db>())
            .unwrap_or_default()
            .into_iter()
            .find(|s| same(&s.project.path, &path))
            .map(|s| s.project.id);
        if let Some(id) = id {
            run_trigger_and_report(&app, "commit", Some(&id), None).await;
        }
    });
}

/// Handles `RunEvent::ExitRequested` from the user closing the app: due "quit" automations get up to a
/// minute to finish before the app really exits. Our own `exit(0)` has a code and never comes here.
pub fn on_exit_requested(app: &AppHandle, api: &tauri::ExitRequestApi) {
    let state = app.state::<AutomationState>();
    if state.quitting.load(Ordering::SeqCst) {
        api.prevent_exit();
        return;
    }
    if !automations::any_due(&app.state::<Db>(), "quit") {
        return;
    }
    state.quitting.store(true, Ordering::SeqCst);
    api.prevent_exit();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // The timeout also covers waiting behind a long-running job; dropping its future kills the children.
        let deadline = Instant::now() + QUIT_BUDGET;
        let _ = tokio::time::timeout(
            QUIT_BUDGET + Duration::from_secs(5),
            run_trigger_and_report(&app, "quit", None, Some(deadline)),
        )
        .await;
        app.exit(0);
    });
}

/// Manual "Run now": ignores the date/repeat, still honours the requisites.
#[tauri::command]
pub async fn automation_run(app: AppHandle, db: State<'_, Db>, id: String, project_id: Option<String>) -> Result<RunSummary> {
    let a = automations::get_automation(&db, &id)?;
    let state = app.state::<AutomationState>();
    let _lock = state.run_lock.lock().await;
    let opts = RunOpts { only_due: false, project_id, deadline: None };
    let sum = automations::run_automation(&db, &a, &opts).await?;
    report(&app, std::slice::from_ref(&sum));
    Ok(sum)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(branch: &str, head: &str, up: Option<&str>) -> GitSeen {
        GitSeen { branch: Some(branch.into()), head: Some(head.into()), upstream: up.map(String::from) }
    }

    #[test]
    fn tells_switches_pushes_fetches_and_pulls_apart() {
        // switch
        assert_eq!(git_events(&seen("main", "a", Some("a")), &seen("feature", "b", None)), vec![("branch", "feature".to_string())]);
        // push: upstream catches up with an unchanged HEAD
        assert_eq!(git_events(&seen("main", "c", Some("a")), &seen("main", "c", Some("c"))), vec![("push", "main".to_string())]);
        // fetch: upstream moves somewhere else
        assert!(git_events(&seen("main", "c", Some("a")), &seen("main", "c", Some("d"))).is_empty());
        // pull: HEAD moves to the upstream
        assert!(git_events(&seen("main", "a", Some("d")), &seen("main", "d", Some("d"))).is_empty());
        // commit: only HEAD moves
        assert!(git_events(&seen("main", "a", Some("a")), &seen("main", "b", Some("a"))).is_empty());
    }
}
