//! Automations: user-defined shell commands that run inside project folders on a trigger.
//! This module is the engine (storage, due logic, requisites, execution). It only needs a `&Db`,
//! so it works without Tauri; `automation_runtime.rs` wires it to app events and notifications.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;

use crate::db::{list_projects, now, Db, Project};
use crate::error::{err, Result};

const HOUR_MS: i64 = 3_600_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OUTPUT_TAIL: usize = 4000;
const RUNS_KEPT: i64 = 200;
const MAX_WALK: usize = 200_000;

const TRIGGERS: [&str; 5] = ["launch", "quit", "manual", "schedule", "commit"];
const NOTIFY: [&str; 3] = ["none", "on_run", "before"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub enabled: bool,
    /// launch | quit | manual | schedule | commit
    pub trigger: String,
    /// First time it may run (epoch ms).
    pub run_at: Option<i64>,
    pub repeat_hours: Option<i64>,
    /// none | on_run | before (before is only valid for `schedule`)
    pub notify: String,
    pub notify_before_min: Option<i64>,
    /// selected | all
    pub target_mode: String,
    pub project_ids: Vec<String>,
    pub kind_filter: Option<String>,
    /// Requisite: the project was not edited for this many hours.
    pub idle_hours: Option<i64>,
    pub require_clean_git: bool,
    pub require_git_repo: bool,
    pub commands: String,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub last_run: Option<i64>,
    #[serde(default)]
    pub last_status: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub project_id: String,
    pub project_name: String,
    pub started_at: i64,
    pub finished_at: i64,
    /// ok | failed | timeout
    pub status: String,
    pub exit_code: Option<i32>,
    pub output: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub project: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub automation_id: String,
    pub name: String,
    pub notify: String,
    pub ok: u32,
    pub failed: u32,
    pub skipped: Vec<Skipped>,
}

impl RunSummary {
    pub fn ran(&self) -> u32 {
        self.ok + self.failed
    }
}

// ---------- storage ----------

fn automation_from_row(r: &Row) -> rusqlite::Result<Automation> {
    let ids: String = r.get("project_ids")?;
    Ok(Automation {
        id: r.get("id")?,
        name: r.get("name")?,
        description: r.get("description")?,
        enabled: r.get("enabled")?,
        trigger: r.get("trigger_kind")?,
        run_at: r.get("run_at")?,
        repeat_hours: r.get("repeat_hours")?,
        notify: r.get("notify")?,
        notify_before_min: r.get("notify_before_min")?,
        target_mode: r.get("target_mode")?,
        project_ids: serde_json::from_str(&ids).unwrap_or_default(),
        kind_filter: r.get("kind_filter")?,
        idle_hours: r.get("idle_hours")?,
        require_clean_git: r.get("require_clean_git")?,
        require_git_repo: r.get("require_git_repo")?,
        commands: r.get("commands")?,
        sort: r.get("sort")?,
        last_run: r.get("last_run")?,
        last_status: r.get("last_status")?,
    })
}

const SELECT_AUTOMATION: &str = "SELECT a.*,
    (SELECT MAX(last_run) FROM automation_state s WHERE s.automation_id=a.id) AS last_run,
    (SELECT status FROM automation_runs r WHERE r.automation_id=a.id ORDER BY started_at DESC LIMIT 1) AS last_status
  FROM automations a";

pub fn list_automations(db: &Db) -> Result<Vec<Automation>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&format!("{SELECT_AUTOMATION} ORDER BY a.sort, a.created_at"))?;
    let rows = stmt.query_map([], automation_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_automation(db: &Db, id: &str) -> Result<Automation> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&format!("{SELECT_AUTOMATION} WHERE a.id=?1"))?;
    let mut rows = stmt.query_map(params![id], automation_from_row)?;
    match rows.next() {
        Some(a) => Ok(a?),
        None => err("Automation not found"),
    }
}

/// Normalises the fields and rejects combinations that could never run.
fn validate(a: &mut Automation) -> Result<()> {
    a.name = a.name.trim().to_string();
    a.description = a.description.trim().to_string();
    if a.name.is_empty() {
        return err("Give the automation a name");
    }
    if a.commands.trim().is_empty() {
        return err("Add at least one command to run");
    }
    if !TRIGGERS.contains(&a.trigger.as_str()) {
        return err("Unknown trigger");
    }
    if !NOTIFY.contains(&a.notify.as_str()) {
        return err("Unknown notification setting");
    }
    if a.repeat_hours.is_some_and(|h| h <= 0) {
        return err("Repeat interval must be at least 1 hour");
    }
    if a.idle_hours.is_some_and(|h| h <= 0) {
        return err("The not-edited window must be at least 1 hour");
    }
    if a.trigger == "schedule" && a.run_at.is_none() && a.repeat_hours.is_none() {
        return err("A scheduled automation needs a date and time or a repeat interval");
    }
    if a.notify == "before" {
        if a.trigger != "schedule" {
            return err("“Before” alerts only work with scheduled automations");
        }
        if !a.notify_before_min.is_some_and(|m| m > 0) {
            return err("Set how many minutes before the run to alert");
        }
    } else {
        a.notify_before_min = None;
    }
    match a.target_mode.as_str() {
        "selected" if a.project_ids.is_empty() => return err("Pick at least one project"),
        "selected" | "all" => {}
        _ => return err("Unknown target"),
    }
    a.kind_filter = a.kind_filter.take().map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    Ok(())
}

pub fn save_automation(db: &Db, mut a: Automation) -> Result<Automation> {
    validate(&mut a)?;
    let ids = serde_json::to_string(&a.project_ids)?;
    let t = now();
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO automations(id,name,description,enabled,trigger_kind,run_at,repeat_hours,notify,notify_before_min,
           target_mode,project_ids,kind_filter,idle_hours,require_clean_git,require_git_repo,commands,sort,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?18)
         ON CONFLICT(id) DO UPDATE SET name=?2,description=?3,enabled=?4,trigger_kind=?5,run_at=?6,repeat_hours=?7,
           notify=?8,notify_before_min=?9,target_mode=?10,project_ids=?11,kind_filter=?12,idle_hours=?13,
           require_clean_git=?14,require_git_repo=?15,commands=?16,sort=?17,updated_at=?18",
        params![
            a.id, a.name, a.description, a.enabled, a.trigger, a.run_at, a.repeat_hours, a.notify, a.notify_before_min,
            a.target_mode, ids, a.kind_filter, a.idle_hours, a.require_clean_git, a.require_git_repo, a.commands, a.sort, t
        ],
    )?;
    drop(conn);
    get_automation(db, &a.id)
}

pub fn delete_automation(db: &Db, id: &str) -> Result<()> {
    let conn = db.0.lock().unwrap();
    for table in ["automations", "automation_runs", "automation_state"] {
        let col = if table == "automations" { "id" } else { "automation_id" };
        conn.execute(&format!("DELETE FROM {table} WHERE {col}=?1"), params![id])?;
    }
    Ok(())
}

pub fn list_runs(db: &Db, automation_id: &str) -> Result<Vec<AutomationRun>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id,automation_id,project_id,project_name,started_at,finished_at,status,exit_code,output
         FROM automation_runs WHERE automation_id=?1 ORDER BY started_at DESC LIMIT 100",
    )?;
    let rows = stmt
        .query_map(params![automation_id], |r| {
            Ok(AutomationRun {
                id: r.get(0)?,
                automation_id: r.get(1)?,
                project_id: r.get(2)?,
                project_name: r.get(3)?,
                started_at: r.get(4)?,
                finished_at: r.get(5)?,
                status: r.get(6)?,
                exit_code: r.get(7)?,
                output: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn last_run(db: &Db, automation_id: &str, project_id: &str) -> Option<i64> {
    let conn = db.0.lock().unwrap();
    conn.query_row(
        "SELECT last_run FROM automation_state WHERE automation_id=?1 AND project_id=?2",
        params![automation_id, project_id],
        |r| r.get(0),
    )
    .ok()
}

/// Stores the run and bumps the per-project "last run" that repeat intervals are measured from.
/// A failed attempt counts too, otherwise a failing command would be retried on every tick.
fn record_run(db: &Db, a: &Automation, p: &Project, started: i64, finished: i64, res: &ShellResult) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO automation_runs(id,automation_id,project_id,project_name,started_at,finished_at,status,exit_code,output)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            uuid::Uuid::new_v4().to_string(), a.id, p.id, p.name, started, finished, res.status, res.exit_code, res.output
        ],
    )?;
    conn.execute(
        "INSERT INTO automation_state(automation_id,project_id,last_run) VALUES(?1,?2,?3)
         ON CONFLICT(automation_id,project_id) DO UPDATE SET last_run=?3",
        params![a.id, p.id, started],
    )?;
    conn.execute(
        "DELETE FROM automation_runs WHERE automation_id=?1 AND id NOT IN
           (SELECT id FROM automation_runs WHERE automation_id=?1 ORDER BY started_at DESC LIMIT ?2)",
        params![a.id, RUNS_KEPT],
    )?;
    Ok(())
}

// ---------- when is it due ----------

/// The earliest time this automation may run again for a project whose last run was `last_run`.
/// `None` means never (manual-only, or a one-off that already ran). `i64::MIN` means "any time".
pub fn next_due(a: &Automation, last_run: Option<i64>) -> Option<i64> {
    if a.trigger == "manual" {
        return None;
    }
    let first = a.run_at;
    match (a.repeat_hours.filter(|h| *h > 0), last_run) {
        (Some(h), Some(l)) => Some((l + h * HOUR_MS).max(first.unwrap_or(i64::MIN))),
        (Some(_), None) => Some(first.unwrap_or(i64::MIN)),
        (None, l) => match (first, l) {
            (Some(f), Some(l)) if l >= f => None,
            (Some(f), _) => Some(f),
            (None, _) => Some(i64::MIN),
        },
    }
}

pub fn is_due(a: &Automation, last_run: Option<i64>, at: i64) -> bool {
    next_due(a, last_run).is_some_and(|n| n <= at)
}

// ---------- targets and requisites ----------

pub fn resolve_targets(db: &Db, a: &Automation) -> Result<Vec<Project>> {
    Ok(list_projects(db)?
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
async fn unmet_requisite(a: &Automation, p: &Project) -> Option<String> {
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

async fn git_porcelain(path: &str) -> std::result::Result<String, String> {
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

// ---------- running ----------

pub struct ShellResult {
    /// ok | failed | timeout
    pub status: String,
    pub exit_code: Option<i32>,
    pub output: String,
}

fn shell_command(script: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        c.creation_flags(0x0800_0000);
        c
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(shell);
        c.args(["-lc", script]);
        c
    }
}

fn tail(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// Runs `script` in the user's shell inside `dir`, capturing stdout + stderr.
pub async fn run_shell(dir: &str, script: &str, timeout: Duration) -> ShellResult {
    let mut cmd = shell_command(script);
    cmd.current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let failed = |msg: String| ShellResult { status: "failed".into(), exit_code: None, output: msg };
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return failed(format!("Could not start the shell: {e}")),
    };
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => ShellResult {
            status: "timeout".into(),
            exit_code: None,
            output: format!("Stopped after {} min without finishing.", (timeout.as_secs() / 60).max(1)),
        },
        Ok(Err(e)) => failed(e.to_string()),
        Ok(Ok(o)) => {
            let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            ShellResult {
                status: if o.status.success() { "ok" } else { "failed" }.into(),
                exit_code: o.status.code(),
                output: tail(&text, OUTPUT_TAIL),
            }
        }
    }
}

pub struct RunOpts {
    /// Only projects whose repeat/date is due (automatic triggers); manual runs pass false.
    pub only_due: bool,
    pub project_id: Option<String>,
    /// Hard stop for the whole batch (used on quit).
    pub deadline: Option<Instant>,
}

pub async fn run_automation(db: &Db, a: &Automation, opts: &RunOpts) -> Result<RunSummary> {
    let mut sum = RunSummary { automation_id: a.id.clone(), name: a.name.clone(), notify: a.notify.clone(), ok: 0, failed: 0, skipped: vec![] };
    for p in resolve_targets(db, a)? {
        if opts.project_id.as_deref().is_some_and(|id| id != p.id) {
            continue;
        }
        if opts.only_due && !is_due(a, last_run(db, &a.id, &p.id), now()) {
            continue;
        }
        let mut timeout = RUN_TIMEOUT;
        if let Some(d) = opts.deadline {
            let left = d.saturating_duration_since(Instant::now());
            if left.is_zero() {
                sum.skipped.push(Skipped { project: p.name.clone(), reason: "out of time".into() });
                continue;
            }
            timeout = timeout.min(left);
        }
        if let Some(reason) = unmet_requisite(a, &p).await {
            sum.skipped.push(Skipped { project: p.name.clone(), reason });
            continue;
        }
        let started = now();
        let res = run_shell(&p.path, &a.commands, timeout).await;
        record_run(db, a, &p, started, now(), &res)?;
        if res.status == "ok" {
            sum.ok += 1;
        } else {
            sum.failed += 1;
        }
    }
    Ok(sum)
}

/// Runs every enabled automation of `trigger` that is due; returns only those that ran something.
pub async fn run_trigger(db: &Db, trigger: &str, project_id: Option<&str>, deadline: Option<Instant>) -> Vec<RunSummary> {
    let opts = RunOpts { only_due: true, project_id: project_id.map(String::from), deadline };
    let mut out = vec![];
    for a in list_automations(db).unwrap_or_default() {
        if !a.enabled || a.trigger != trigger {
            continue;
        }
        if let Ok(s) = run_automation(db, &a, &opts).await {
            if s.ran() > 0 {
                out.push(s);
            }
        }
    }
    out
}

/// Whether any enabled automation of `trigger` has a project due (requisites not checked).
pub fn any_due(db: &Db, trigger: &str) -> bool {
    let t = now();
    list_automations(db).unwrap_or_default().iter().filter(|a| a.enabled && a.trigger == trigger).any(|a| {
        resolve_targets(db, a).unwrap_or_default().iter().any(|p| is_due(a, last_run(db, &a.id, &p.id), t))
    })
}

/// The soonest time any of the automation's projects becomes due.
pub fn soonest_due(db: &Db, a: &Automation) -> Option<i64> {
    resolve_targets(db, a)
        .unwrap_or_default()
        .iter()
        .filter_map(|p| next_due(a, last_run(db, &a.id, &p.id)))
        .min()
}

// ---------- commands ----------

#[tauri::command]
pub async fn automations_list(db: State<'_, Db>) -> Result<Vec<Automation>> {
    list_automations(&db)
}

#[tauri::command]
pub async fn automation_save(db: State<'_, Db>, automation: Automation) -> Result<Automation> {
    save_automation(&db, automation)
}

#[tauri::command]
pub async fn automation_delete(db: State<'_, Db>, id: String) -> Result<()> {
    delete_automation(&db, &id)
}

#[tauri::command]
pub async fn automation_runs(db: State<'_, Db>, id: String) -> Result<Vec<AutomationRun>> {
    list_runs(&db, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auto(trigger: &str) -> Automation {
        Automation {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Test".into(),
            description: String::new(),
            enabled: true,
            trigger: trigger.into(),
            run_at: None,
            repeat_hours: None,
            notify: "none".into(),
            notify_before_min: None,
            target_mode: "all".into(),
            project_ids: vec![],
            kind_filter: None,
            idle_hours: None,
            require_clean_git: false,
            require_git_repo: false,
            commands: "true".into(),
            sort: 0,
            last_run: None,
            last_status: None,
        }
    }

    fn temp_db() -> Db {
        Db::open(&std::env::temp_dir().join(format!("bp-auto-{}.db", uuid::Uuid::new_v4()))).unwrap()
    }

    fn temp_dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bp-auto-dir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn project(db: &Db, name: &str, kind: &str, dir: &Path) -> Project {
        let t = now();
        crate::db::save_project(
            db,
            Project {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.into(),
                description: None,
                path: dir.to_string_lossy().to_string(),
                kind: kind.into(),
                favorite: false,
                github_url: None,
                website_url: None,
                default_editor: None,
                default_terminal: None,
                default_command_id: None,
                last_opened: None,
                created_at: t,
                updated_at: t,
            },
        )
        .unwrap()
    }

    fn age(file: &Path, hours: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(file).unwrap();
        f.set_modified(std::time::SystemTime::now() - Duration::from_secs(hours * 3600)).unwrap();
    }

    #[test]
    fn manual_is_never_auto_due() {
        assert!(!is_due(&auto("manual"), None, now()));
    }

    #[test]
    fn no_repeat_no_date_always_runs() {
        let a = auto("launch");
        assert!(is_due(&a, None, now()));
        assert!(is_due(&a, Some(now()), now()));
    }

    #[test]
    fn repeat_waits_for_the_interval() {
        let mut a = auto("launch");
        a.repeat_hours = Some(48);
        let t = 1_000_000_000_000;
        assert!(is_due(&a, None, t));
        assert!(!is_due(&a, Some(t), t + 47 * HOUR_MS));
        assert!(is_due(&a, Some(t), t + 48 * HOUR_MS));
    }

    #[test]
    fn future_date_blocks_until_reached() {
        let mut a = auto("launch");
        a.repeat_hours = Some(24);
        a.run_at = Some(5_000);
        assert!(!is_due(&a, None, 4_999));
        assert!(is_due(&a, None, 5_000));
        // The interval is measured from the last run but never before the start date.
        assert_eq!(next_due(&a, Some(0)), Some(24 * HOUR_MS));
    }

    #[test]
    fn one_off_runs_once() {
        let mut a = auto("schedule");
        a.run_at = Some(5_000);
        assert!(is_due(&a, None, 6_000));
        assert!(!is_due(&a, Some(6_000), 7_000));
        // Moving the date forward re-arms it.
        a.run_at = Some(9_000);
        assert!(is_due(&a, Some(6_000), 9_000));
    }

    #[test]
    fn validation_rejects_impossible_setups() {
        let mut a = auto("schedule");
        assert!(validate(&mut a).is_err(), "schedule without date or repeat");
        a.repeat_hours = Some(1);
        assert!(validate(&mut a).is_ok());

        let mut b = auto("launch");
        b.notify = "before".into();
        b.notify_before_min = Some(5);
        assert!(validate(&mut b).is_err(), "before only for schedule");

        let mut c = auto("launch");
        c.target_mode = "selected".into();
        assert!(validate(&mut c).is_err(), "selected needs projects");

        let mut d = auto("launch");
        d.commands = "  ".into();
        assert!(validate(&mut d).is_err());
        let mut e = auto("launch");
        e.name = " ".into();
        assert!(validate(&mut e).is_err());
    }

    #[test]
    fn targets_follow_selection_kind_and_folder() {
        let db = temp_db();
        let (d1, d2) = (temp_dir(), temp_dir());
        let tauri = project(&db, "A", "Tauri", &d1);
        let node = project(&db, "B", "Node.js", &d2);
        project(&db, "Gone", "Tauri", &std::env::temp_dir().join("bp-does-not-exist"));

        let mut all = auto("launch");
        assert_eq!(resolve_targets(&db, &all).unwrap().len(), 2, "missing folder is skipped");
        all.kind_filter = Some("tauri".into());
        let t = resolve_targets(&db, &all).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, tauri.id);

        let mut sel = auto("launch");
        sel.target_mode = "selected".into();
        sel.project_ids = vec![node.id.clone()];
        let t = resolve_targets(&db, &sel).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, node.id);
    }

    #[test]
    fn edited_within_ignores_old_files_and_node_modules() {
        let dir = temp_dir();
        let old = dir.join("old.txt");
        std::fs::write(&old, "x").unwrap();
        age(&old, 100);
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules/new.js"), "x").unwrap();
        assert!(!edited_within(&dir, Duration::from_secs(48 * 3600)));
        std::fs::write(dir.join("fresh.txt"), "x").unwrap();
        assert!(edited_within(&dir, Duration::from_secs(48 * 3600)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_reports_status_exit_code_and_output() {
        let dir = temp_dir();
        let d = dir.to_string_lossy().to_string();
        let ok = run_shell(&d, "echo hi", Duration::from_secs(10)).await;
        assert_eq!((ok.status.as_str(), ok.exit_code), ("ok", Some(0)));
        assert!(ok.output.contains("hi"));
        let bad = run_shell(&d, "echo boom >&2; exit 3", Duration::from_secs(10)).await;
        assert_eq!((bad.status.as_str(), bad.exit_code), ("failed", Some(3)));
        assert!(bad.output.contains("boom"));
        let slow = run_shell(&d, "sleep 5", Duration::from_millis(200)).await;
        assert_eq!(slow.status, "timeout");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_records_state_and_respects_repeat_and_idle() {
        let db = temp_db();
        let dir = temp_dir();
        let stale = dir.join("a.txt");
        std::fs::write(&stale, "x").unwrap();
        age(&stale, 100);
        let p = project(&db, "P", "Other", &dir);

        let mut a = auto("launch");
        a.target_mode = "selected".into();
        a.project_ids = vec![p.id.clone()];
        a.repeat_hours = Some(48);
        a.idle_hours = Some(48);
        a.commands = "echo done > out.txt".into();
        let a = save_automation(&db, a).unwrap();

        let opts = RunOpts { only_due: true, project_id: None, deadline: None };
        let s = run_automation(&db, &a, &opts).await.unwrap();
        assert_eq!((s.ok, s.failed), (1, 0));
        assert!(dir.join("out.txt").exists());
        assert_eq!(list_runs(&db, &a.id).unwrap().len(), 1);

        // Inside the repeat window nothing runs, and nothing is reported as skipped.
        let s = run_automation(&db, &a, &opts).await.unwrap();
        assert_eq!((s.ran(), s.skipped.len()), (0, 0));

        // A manual run still honours the idle requisite: out.txt is fresh now.
        let manual = RunOpts { only_due: false, project_id: None, deadline: None };
        let s = run_automation(&db, &a, &manual).await.unwrap();
        assert_eq!(s.ran(), 0);
        assert_eq!(s.skipped.len(), 1);
        assert!(s.skipped[0].reason.contains("edited"));
        assert_eq!(get_automation(&db, &a.id).unwrap().last_status.as_deref(), Some("ok"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn clean_git_requisite_blocks_dirty_repos() {
        let db = temp_db();
        let dir = temp_dir();
        let g = |args: &[&str]| {
            assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap().status.success())
        };
        g(&["init", "-q"]);
        let p = project(&db, "Repo", "Other", &dir);
        let mut a = auto("manual");
        a.require_clean_git = true;
        a.commands = "true".into();
        let opts = RunOpts { only_due: false, project_id: Some(p.id.clone()), deadline: None };
        assert_eq!(run_automation(&db, &a, &opts).await.unwrap().ran(), 1, "empty repo is clean");
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        let s = run_automation(&db, &a, &opts).await.unwrap();
        assert_eq!((s.ran(), s.skipped[0].reason.as_str()), (0, "uncommitted changes"));
    }
}
