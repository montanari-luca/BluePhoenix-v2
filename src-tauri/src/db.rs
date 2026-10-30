use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::Result;

pub struct Db(pub Mutex<Connection>);

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

const MIGRATION_1: &str = r#"
CREATE TABLE projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Other', favorite INTEGER NOT NULL DEFAULT 0,
  github_url TEXT, website_url TEXT, default_editor TEXT, default_terminal TEXT,
  default_command_id TEXT, last_opened INTEGER, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE commands(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL, command TEXT NOT NULL,
  cwd TEXT, source TEXT NOT NULL DEFAULT 'manual', sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE todo_pages(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE todos(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, page_id TEXT, title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 0,
  due INTEGER, ai_prompt TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  completed_at INTEGER, updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE time_entries(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, todo_id TEXT, minutes INTEGER NOT NULL,
  logged_at INTEGER NOT NULL, note TEXT, updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE files(
  project_id TEXT NOT NULL, rel_path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, rel_path)
);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX idx_todos_project ON todos(project_id);
CREATE INDEX idx_time_project ON time_entries(project_id);
CREATE INDEX idx_cmd_project ON commands(project_id);
"#;

// Automations are local-only: no `dirty`/`deleted` columns, and they are not part of cloud sync.
const MIGRATION_2: &str = r#"
CREATE TABLE automations(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, trigger_kind TEXT NOT NULL, run_at INTEGER, repeat_hours INTEGER,
  notify TEXT NOT NULL DEFAULT 'none', notify_before_min INTEGER,
  target_mode TEXT NOT NULL DEFAULT 'selected', project_ids TEXT NOT NULL DEFAULT '[]', kind_filter TEXT,
  idle_hours INTEGER, require_clean_git INTEGER NOT NULL DEFAULT 0, require_git_repo INTEGER NOT NULL DEFAULT 0,
  commands TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE automation_runs(
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, project_id TEXT NOT NULL, project_name TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, status TEXT NOT NULL,
  exit_code INTEGER, output TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_autorun_automation ON automation_runs(automation_id, started_at);
CREATE TABLE automation_state(
  automation_id TEXT NOT NULL, project_id TEXT NOT NULL, last_run INTEGER NOT NULL,
  PRIMARY KEY(automation_id, project_id)
);
"#;

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(MIGRATION_1)?;
            conn.pragma_update(None, "user_version", 1)?;
        }
        if version < 2 {
            conn.execute_batch(MIGRATION_2)?;
            conn.pragma_update(None, "user_version", 2)?;
        }
        Ok(Db(Mutex::new(conn)))
    }
}

// ---------- models ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub path: String,
    pub kind: String,
    pub favorite: bool,
    pub github_url: Option<String>,
    pub website_url: Option<String>,
    pub default_editor: Option<String>,
    pub default_terminal: Option<String>,
    pub default_command_id: Option<String>,
    pub last_opened: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn project_from_row(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get("id")?,
        name: r.get("name")?,
        description: r.get("description")?,
        path: r.get("path")?,
        kind: r.get("kind")?,
        favorite: r.get("favorite")?,
        github_url: r.get("github_url")?,
        website_url: r.get("website_url")?,
        default_editor: r.get("default_editor")?,
        default_terminal: r.get("default_terminal")?,
        default_command_id: r.get("default_command_id")?,
        last_opened: r.get("last_opened")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    #[serde(flatten)]
    pub project: Project,
    pub total_minutes: i64,
    pub open_todos: i64,
    pub done_todos: i64,
    pub last_activity: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub command: String,
    pub cwd: Option<String>,
    pub source: String,
    pub sort: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TodoPage {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub markdown: String,
    pub sort: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub project_id: String,
    pub page_id: Option<String>,
    pub title: String,
    pub notes: String,
    pub status: String,
    pub priority: i64,
    pub due: Option<i64>,
    pub ai_prompt: Option<String>,
    pub sort: i64,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntry {
    pub id: String,
    pub project_id: String,
    pub todo_id: Option<String>,
    pub minutes: i64,
    pub logged_at: i64,
    pub note: Option<String>,
}

// ---------- projects ----------

#[tauri::command]
pub async fn projects_list(db: State<'_, Db>) -> Result<Vec<ProjectSummary>> {
    list_projects(&db)
}

pub fn list_projects(db: &Db) -> Result<Vec<ProjectSummary>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT p.*,
          COALESCE((SELECT SUM(minutes) FROM time_entries t WHERE t.project_id=p.id AND t.deleted=0),0) AS total_minutes,
          (SELECT COUNT(*) FROM todos o WHERE o.project_id=p.id AND o.deleted=0 AND o.status!='done') AS open_todos,
          (SELECT COUNT(*) FROM todos o WHERE o.project_id=p.id AND o.deleted=0 AND o.status='done') AS done_todos,
          MAX(p.created_at,
              COALESCE((SELECT MAX(updated_at) FROM todos o WHERE o.project_id=p.id AND o.deleted=0),0),
              COALESCE((SELECT MAX(logged_at) FROM time_entries t WHERE t.project_id=p.id AND t.deleted=0),0),
              COALESCE(p.last_opened,0)) AS last_activity
         FROM projects p WHERE p.deleted=0
         ORDER BY p.favorite DESC, COALESCE(p.last_opened,0) DESC, p.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProjectSummary {
                project: project_from_row(r)?,
                total_minutes: r.get("total_minutes")?,
                open_todos: r.get("open_todos")?,
                done_todos: r.get("done_todos")?,
                last_activity: r.get("last_activity")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn project_save(db: State<'_, Db>, project: Project) -> Result<Project> {
    save_project(&db, project)
}

pub fn save_project(db: &Db, project: Project) -> Result<Project> {
    let conn = db.0.lock().unwrap();
    let t = now();
    conn.execute(
        "INSERT INTO projects(id,name,description,path,kind,favorite,github_url,website_url,default_editor,
           default_terminal,default_command_id,last_opened,created_at,updated_at,deleted,dirty)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,1)
         ON CONFLICT(id) DO UPDATE SET name=?2,description=?3,path=?4,kind=?5,favorite=?6,github_url=?7,
           website_url=?8,default_editor=?9,default_terminal=?10,default_command_id=?11,last_opened=?12,
           updated_at=?14,deleted=0,dirty=1",
        params![
            project.id, project.name, project.description, project.path, project.kind, project.favorite,
            project.github_url, project.website_url, project.default_editor, project.default_terminal,
            project.default_command_id, project.last_opened, project.created_at, t
        ],
    )?;
    Ok(Project { updated_at: t, ..project })
}

#[tauri::command]
pub async fn project_touch(db: State<'_, Db>, id: String) -> Result<()> {
    let conn = db.0.lock().unwrap();
    // Local-only bookkeeping: does not mark the row dirty for sync.
    conn.execute("UPDATE projects SET last_opened=?1 WHERE id=?2", params![now(), id])?;
    Ok(())
}

#[tauri::command]
pub async fn project_remove(db: State<'_, Db>, id: String) -> Result<()> {
    let conn = db.0.lock().unwrap();
    let t = now();
    for table in ["projects", "commands", "todo_pages", "todos", "time_entries"] {
        let col = if table == "projects" { "id" } else { "project_id" };
        conn.execute(
            &format!("UPDATE {table} SET deleted=1, dirty=1, updated_at=?1 WHERE {col}=?2"),
            params![t, id],
        )?;
    }
    conn.execute("DELETE FROM files WHERE project_id=?1", params![id])?;
    Ok(())
}

// ---------- commands ----------

#[tauri::command]
pub async fn commands_list(db: State<'_, Db>, project_id: String) -> Result<Vec<Command>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id,project_id,label,command,cwd,source,sort FROM commands
         WHERE project_id=?1 AND deleted=0 ORDER BY sort, label COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(Command {
                id: r.get(0)?,
                project_id: r.get(1)?,
                label: r.get(2)?,
                command: r.get(3)?,
                cwd: r.get(4)?,
                source: r.get(5)?,
                sort: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn command_save(db: State<'_, Db>, command: Command) -> Result<()> {
    save_command(&db, &command)
}

pub fn save_command(db: &Db, command: &Command) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO commands(id,project_id,label,command,cwd,source,sort,updated_at,deleted,dirty)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,1)
         ON CONFLICT(id) DO UPDATE SET label=?3,command=?4,cwd=?5,source=?6,sort=?7,updated_at=?8,deleted=0,dirty=1",
        params![command.id, command.project_id, command.label, command.command, command.cwd, command.source, command.sort, now()],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn command_delete(db: State<'_, Db>, id: String) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute("UPDATE commands SET deleted=1,dirty=1,updated_at=?1 WHERE id=?2", params![now(), id])?;
    Ok(())
}

// ---------- todo pages ----------

#[tauri::command]
pub async fn pages_list(db: State<'_, Db>, project_id: String) -> Result<Vec<TodoPage>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id,project_id,title,markdown,sort FROM todo_pages WHERE project_id=?1 AND deleted=0 ORDER BY sort, title COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(TodoPage { id: r.get(0)?, project_id: r.get(1)?, title: r.get(2)?, markdown: r.get(3)?, sort: r.get(4)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn page_save(db: State<'_, Db>, page: TodoPage) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO todo_pages(id,project_id,title,markdown,sort,updated_at,deleted,dirty)
         VALUES(?1,?2,?3,?4,?5,?6,0,1)
         ON CONFLICT(id) DO UPDATE SET title=?3,markdown=?4,sort=?5,updated_at=?6,deleted=0,dirty=1",
        params![page.id, page.project_id, page.title, page.markdown, page.sort, now()],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn page_delete(db: State<'_, Db>, id: String) -> Result<()> {
    let conn = db.0.lock().unwrap();
    let t = now();
    conn.execute("UPDATE todo_pages SET deleted=1,dirty=1,updated_at=?1 WHERE id=?2", params![t, id])?;
    // To-dos of a deleted page fall back to the General list.
    conn.execute("UPDATE todos SET page_id=NULL,dirty=1,updated_at=?1 WHERE page_id=?2", params![t, id])?;
    Ok(())
}

// ---------- todos ----------

fn todo_from_row(r: &Row) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        page_id: r.get("page_id")?,
        title: r.get("title")?,
        notes: r.get("notes")?,
        status: r.get("status")?,
        priority: r.get("priority")?,
        due: r.get("due")?,
        ai_prompt: r.get("ai_prompt")?,
        sort: r.get("sort")?,
        created_at: r.get("created_at")?,
        completed_at: r.get("completed_at")?,
    })
}

#[tauri::command]
pub async fn todos_list(db: State<'_, Db>, project_id: String) -> Result<Vec<Todo>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT * FROM todos WHERE project_id=?1 AND deleted=0 ORDER BY (status='done'), sort, created_at",
    )?;
    let rows = stmt.query_map(params![project_id], todo_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn upsert_todo(conn: &Connection, todo: &Todo) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO todos(id,project_id,page_id,title,notes,status,priority,due,ai_prompt,sort,created_at,completed_at,updated_at,deleted,dirty)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,1)
         ON CONFLICT(id) DO UPDATE SET page_id=?3,title=?4,notes=?5,status=?6,priority=?7,due=?8,ai_prompt=?9,
           sort=?10,completed_at=?12,updated_at=?13,deleted=0,dirty=1",
        params![
            todo.id, todo.project_id, todo.page_id, todo.title, todo.notes, todo.status, todo.priority,
            todo.due, todo.ai_prompt, todo.sort, todo.created_at, todo.completed_at, now()
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn todo_save(db: State<'_, Db>, todo: Todo) -> Result<()> {
    let conn = db.0.lock().unwrap();
    upsert_todo(&conn, &todo)?;
    Ok(())
}

#[tauri::command]
pub async fn todos_save_many(db: State<'_, Db>, todos: Vec<Todo>) -> Result<()> {
    let mut conn = db.0.lock().unwrap();
    let tx = conn.transaction()?;
    for t in &todos {
        upsert_todo(&tx, t)?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub async fn todo_delete(db: State<'_, Db>, id: String) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute("UPDATE todos SET deleted=1,dirty=1,updated_at=?1 WHERE id=?2", params![now(), id])?;
    Ok(())
}

// ---------- time ----------

#[tauri::command]
pub async fn time_list(db: State<'_, Db>, project_id: String) -> Result<Vec<TimeEntry>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id,project_id,todo_id,minutes,logged_at,note FROM time_entries
         WHERE project_id=?1 AND deleted=0 ORDER BY logged_at DESC",
    )?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(TimeEntry {
                id: r.get(0)?,
                project_id: r.get(1)?,
                todo_id: r.get(2)?,
                minutes: r.get(3)?,
                logged_at: r.get(4)?,
                note: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn time_save(db: State<'_, Db>, entry: TimeEntry) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO time_entries(id,project_id,todo_id,minutes,logged_at,note,updated_at,deleted,dirty)
         VALUES(?1,?2,?3,?4,?5,?6,?7,0,1)
         ON CONFLICT(id) DO UPDATE SET todo_id=?3,minutes=?4,logged_at=?5,note=?6,updated_at=?7,deleted=0,dirty=1",
        params![entry.id, entry.project_id, entry.todo_id, entry.minutes, entry.logged_at, entry.note, now()],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn time_delete(db: State<'_, Db>, id: String) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute("UPDATE time_entries SET deleted=1,dirty=1,updated_at=?1 WHERE id=?2", params![now(), id])?;
    Ok(())
}

// ---------- settings ----------

#[tauri::command]
pub async fn settings_get_all(db: State<'_, Db>) -> Result<HashMap<String, String>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare("SELECT key,value FROM settings")?;
    let map = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(map)
}

#[tauri::command]
pub async fn settings_set(db: State<'_, Db>, key: String, value: String) -> Result<()> {
    set_setting(&db, &key, &value)
}

pub fn set_setting(db: &Db, key: &str, value: &str) -> Result<()> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
        params![key, value],
    )?;
    Ok(())
}

pub fn setting(db: &Db, key: &str) -> Option<String> {
    let conn = db.0.lock().unwrap();
    conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0)).ok()
}
