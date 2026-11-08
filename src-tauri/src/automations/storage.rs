//! Storage: automations and their run history in SQLite.

use super::*;

pub(super) fn automation_from_row(r: &Row) -> rusqlite::Result<Automation> {
    let ids: String = r.get("project_ids")?;
    Ok(Automation {
        id: r.get("id")?,
        name: r.get("name")?,
        description: r.get("description")?,
        enabled: r.get("enabled")?,
        trigger: r.get("trigger_kind")?,
        trigger_filter: r.get("trigger_filter")?,
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

pub(super) const SELECT_AUTOMATION: &str = "SELECT a.*,
    (SELECT MAX(last_run) FROM automation_state s WHERE s.automation_id=a.id) AS last_run,
    (SELECT status FROM automation_runs r WHERE r.automation_id=a.id ORDER BY started_at DESC LIMIT 1) AS last_status
  FROM automations a";

pub fn list_automations(db: &Db) -> Result<Vec<Automation>> {
    let conn = db.0.lock_ok();
    let mut stmt = conn.prepare(&format!("{SELECT_AUTOMATION} ORDER BY a.sort, a.created_at"))?;
    let rows = stmt.query_map([], automation_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_automation(db: &Db, id: &str) -> Result<Automation> {
    let conn = db.0.lock_ok();
    let mut stmt = conn.prepare(&format!("{SELECT_AUTOMATION} WHERE a.id=?1"))?;
    let mut rows = stmt.query_map(params![id], automation_from_row)?;
    match rows.next() {
        Some(a) => Ok(a?),
        None => err("Automation not found"),
    }
}

/// Normalises the fields and rejects combinations that could never run.
pub(super) fn validate(a: &mut Automation) -> Result<()> {
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
    a.trigger_filter = a.trigger_filter.take().map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    match (a.trigger.as_str(), a.trigger_filter.as_deref()) {
        ("files", None) => return err("Say which files count, for example src/**/*.ts"),
        ("files" | "branch" | "push", Some(f)) => {
            build(f).map_err(AppError::from)?;
        }
        _ => a.trigger_filter = None,
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
    let conn = db.0.lock_ok();
    conn.execute(
        "INSERT INTO automations(id,name,description,enabled,trigger_kind,run_at,repeat_hours,notify,notify_before_min,
           target_mode,project_ids,kind_filter,idle_hours,require_clean_git,require_git_repo,commands,sort,created_at,updated_at,trigger_filter)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?18,?19)
         ON CONFLICT(id) DO UPDATE SET name=?2,description=?3,enabled=?4,trigger_kind=?5,run_at=?6,repeat_hours=?7,
           notify=?8,notify_before_min=?9,target_mode=?10,project_ids=?11,kind_filter=?12,idle_hours=?13,
           require_clean_git=?14,require_git_repo=?15,commands=?16,sort=?17,updated_at=?18,trigger_filter=?19",
        params![
            a.id, a.name, a.description, a.enabled, a.trigger, a.run_at, a.repeat_hours, a.notify, a.notify_before_min,
            a.target_mode, ids, a.kind_filter, a.idle_hours, a.require_clean_git, a.require_git_repo, a.commands, a.sort, t,
            a.trigger_filter
        ],
    )?;
    drop(conn);
    get_automation(db, &a.id)
}

pub fn delete_automation(db: &Db, id: &str) -> Result<()> {
    let conn = db.0.lock_ok();
    for table in ["automations", "automation_runs", "automation_state"] {
        let col = if table == "automations" { "id" } else { "automation_id" };
        conn.execute(&format!("DELETE FROM {table} WHERE {col}=?1"), params![id])?;
    }
    Ok(())
}

pub fn list_runs(db: &Db, automation_id: &str) -> Result<Vec<AutomationRun>> {
    let conn = db.0.lock_ok();
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

pub(super) fn last_run(db: &Db, automation_id: &str, project_id: &str) -> Option<i64> {
    let conn = db.0.lock_ok();
    conn.query_row(
        "SELECT last_run FROM automation_state WHERE automation_id=?1 AND project_id=?2",
        params![automation_id, project_id],
        |r| r.get(0),
    )
    .ok()
}

/// Stores the run and bumps the per-project "last run" that repeat intervals are measured from.
/// A failed attempt counts too, otherwise a failing command would be retried on every tick.
pub(super) fn record_run(db: &Db, a: &Automation, p: &Project, started: i64, finished: i64, res: &ShellResult) -> Result<()> {
    let conn = db.0.lock_ok();
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
