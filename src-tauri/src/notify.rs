//! System notifications, each kind with its own switch in Settings (`notify.<kind>`, on by default):
//! failed automations, fork updates, and a once-a-day reminder of to-dos due today.

use std::time::Duration;

use chrono::{Local, TimeZone, Timelike};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::{now, set_setting, setting, Db};
use crate::error::LockExt;
use crate::scheduler::Job;

pub const AUTOMATION_FAILED: &str = "automationFailed";
pub const FORK: &str = "fork";
pub const TODO_DUE: &str = "todoDue";

/// The due-today reminder is not sent before this hour (local time).
const DUE_HOUR: u32 = 9;

pub fn enabled(db: &Db, kind: &str) -> bool {
    setting(db, &format!("notify.{kind}")).is_none_or(|v| v != "false")
}

/// Shows a notification of `kind` unless the user turned that kind off.
pub fn send(app: &AppHandle, kind: &str, title: &str, body: &str) {
    if enabled(&app.state::<Db>(), kind) {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

/// Open to-dos due by the end of `day_end` (epoch ms), overdue ones included: (title, project).
pub fn due_todos(db: &Db, day_end: i64) -> Vec<(String, String)> {
    let conn = db.0.lock_ok();
    let Ok(mut stmt) = conn.prepare(
        "SELECT t.title, p.name FROM todos t JOIN projects p ON p.id=t.project_id
         WHERE t.deleted=0 AND t.status!='done' AND t.due IS NOT NULL AND t.due<=?1
           AND p.deleted=0 AND p.archived_at IS NULL
         ORDER BY t.due, t.priority DESC",
    ) else {
        return vec![];
    };
    stmt.query_map([day_end], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

pub fn due_message(todos: &[(String, String)]) -> (String, String) {
    let n = todos.len();
    let title = if n == 1 { "1 to-do is due today".to_string() } else { format!("{n} to-dos are due today") };
    let mut body: Vec<String> = todos.iter().take(3).map(|(t, p)| format!("{t} ({p})")).collect();
    if n > 3 {
        body.push(format!("and {} more", n - 3));
    }
    (title, body.join(", "))
}

fn remind_due(app: &AppHandle) {
    let db = app.state::<Db>();
    let local = Local::now();
    let today = local.format("%Y-%m-%d").to_string();
    if local.hour() < DUE_HOUR || setting(&db, "notify.todoDueSent").as_deref() == Some(&today) || !enabled(&db, TODO_DUE) {
        return;
    }
    let end = Local
        .from_local_datetime(&local.date_naive().and_hms_opt(23, 59, 59).expect("valid time"))
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or_else(now);
    let todos = due_todos(&db, end);
    let _ = set_setting(&db, "notify.todoDueSent", &today);
    if !todos.is_empty() {
        let (title, body) = due_message(&todos);
        send(app, TODO_DUE, &title, &body);
    }
}

pub fn jobs() -> Vec<Job> {
    vec![Job::every("due reminder", Duration::from_secs(90), Duration::from_secs(15 * 60), |app| async move {
        remind_due(&app);
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_due_and_overdue_open_todos_only() {
        let db = Db::open(&std::env::temp_dir().join(format!("bp-notify-{}.db", uuid::Uuid::new_v4()))).unwrap();
        db.0.lock_ok()
            .execute_batch(
                "INSERT INTO projects(id,name,path,created_at,updated_at) VALUES('p','Shop','/s',1,1);
                 INSERT INTO projects(id,name,path,created_at,updated_at,archived_at) VALUES('a','Old','/o',1,1,5);
                 INSERT INTO todos(id,project_id,title,due,created_at,updated_at) VALUES('1','p','Overdue',100,1,1);
                 INSERT INTO todos(id,project_id,title,due,created_at,updated_at) VALUES('2','p','Today',900,1,1);
                 INSERT INTO todos(id,project_id,title,due,created_at,updated_at) VALUES('3','p','Tomorrow',2000,1,1);
                 INSERT INTO todos(id,project_id,title,status,due,created_at,updated_at) VALUES('4','p','Done','done',100,1,1);
                 INSERT INTO todos(id,project_id,title,due,created_at,updated_at) VALUES('5','a','Archived',100,1,1);",
            )
            .unwrap();
        let due = due_todos(&db, 1000);
        assert_eq!(due, vec![("Overdue".to_string(), "Shop".to_string()), ("Today".to_string(), "Shop".to_string())]);
        assert!(enabled(&db, TODO_DUE));
        set_setting(&db, "notify.todoDue", "false").unwrap();
        assert!(!enabled(&db, TODO_DUE));
    }

    #[test]
    fn summarises_many_todos() {
        let t: Vec<(String, String)> = (1..=5).map(|i| (format!("T{i}"), "P".to_string())).collect();
        let (title, body) = due_message(&t);
        assert_eq!(title, "5 to-dos are due today");
        assert_eq!(body, "T1 (P), T2 (P), T3 (P), and 2 more");
        assert_eq!(due_message(&t[..1]).0, "1 to-do is due today");
    }
}
