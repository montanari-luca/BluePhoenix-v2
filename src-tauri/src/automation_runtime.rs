//! Connects the automations engine to the running app: launch / schedule / commit / quit triggers,
//! system notifications and the `automation-finished` event the UI listens for.

use std::collections::HashSet;
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
}

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
        }),
    ]
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
