//! Backups of the local database: export to a JSON bundle or a SQLite copy, import (merge) either
//! kind back, and an automatic daily snapshot that keeps the last week.
//!
//! An import adds what is missing and updates rows only where the backup is newer, so it never
//! overwrites more recent work. Imported rows are marked for sync, so other devices get them too.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value as J};
use tauri::{AppHandle, Manager, State};

use crate::db::{now, Db};
use crate::error::{err, LockExt, Result};
use crate::scheduler::Job;

const FORMAT: &str = "bluephoenix-backup";
const KEEP: usize = 7;

/// Tables worth keeping, parents first. Derived data (file index, git summaries, sync cursors,
/// conflict log) is left out and rebuilt by the app.
const TABLES: &[&str] = &[
    "projects",
    "commands",
    "todo_pages",
    "todos",
    "time_entries",
    "automations",
    "automation_runs",
    "automation_state",
    "fork_sync",
    "settings",
];

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Rows added or brought up to date.
    pub changed: usize,
    /// Rows already present and as new (or newer) here.
    pub unchanged: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub created_at: i64,
}

struct Col {
    name: String,
    pk: bool,
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<Col>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt
        .query_map([], |r| Ok(Col { name: r.get(1)?, pk: r.get::<_, i64>(5)? > 0 }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(cols)
}

fn to_json(v: SqlValue) -> J {
    match v {
        SqlValue::Null => J::Null,
        SqlValue::Integer(i) => J::from(i),
        SqlValue::Real(f) => J::from(f),
        SqlValue::Text(s) => J::String(s),
        SqlValue::Blob(_) => J::Null,
    }
}

fn to_sql(v: &J) -> SqlValue {
    match v {
        J::Null => SqlValue::Null,
        J::Bool(b) => SqlValue::Integer(*b as i64),
        J::Number(n) => n.as_i64().map(SqlValue::Integer).or_else(|| n.as_f64().map(SqlValue::Real)).unwrap_or(SqlValue::Null),
        J::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// Every kept table as `{table: [{column: value}]}`, without deleted rows.
pub fn dump(conn: &Connection) -> Result<J> {
    let mut tables = Map::new();
    for t in TABLES {
        let cols = columns(conn, t)?;
        if cols.is_empty() {
            continue; // an older database without this table
        }
        let filter = if cols.iter().any(|c| c.name == "deleted") { " WHERE deleted=0" } else { "" };
        let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        let mut stmt = conn.prepare(&format!("SELECT {} FROM {t}{filter}", names.join(",")))?;
        let rows = stmt
            .query_map([], |r| {
                let mut m = Map::new();
                for (i, n) in names.iter().enumerate() {
                    m.insert(n.to_string(), to_json(r.get::<_, SqlValue>(i)?));
                }
                Ok(J::Object(m))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        tables.insert(t.to_string(), J::Array(rows));
    }
    let mut out = Map::new();
    out.insert("format".into(), J::from(FORMAT));
    out.insert("version".into(), J::from(1));
    out.insert("appVersion".into(), J::from(env!("CARGO_PKG_VERSION")));
    out.insert("exportedAt".into(), J::from(now()));
    out.insert("tables".into(), J::Object(tables));
    Ok(J::Object(out))
}

/// Merges a bundle into the database (see the module docs for the rules).
pub fn merge(conn: &mut Connection, bundle: &J) -> Result<ImportReport> {
    if bundle.get("format").and_then(|v| v.as_str()) != Some(FORMAT) {
        return err("This file is not a BluePhoenix backup");
    }
    let Some(tables) = bundle.get("tables").and_then(|v| v.as_object()) else {
        return err("This backup has no data");
    };
    let mut report = ImportReport::default();
    let tx = conn.transaction()?;
    for t in TABLES {
        let Some(rows) = tables.get(*t).and_then(|v| v.as_array()) else { continue };
        let cols = columns(&tx, t)?;
        let known = |k: &str| cols.iter().any(|c| c.name == k);
        let pk: Vec<&str> = cols.iter().filter(|c| c.pk).map(|c| c.name.as_str()).collect();
        let has_updated = known("updated_at");
        let synced = known("dirty");
        for row in rows {
            let Some(obj) = row.as_object() else { continue };
            let mut names: Vec<&str> = obj.keys().map(|k| k.as_str()).filter(|k| known(k) && *k != "dirty").collect();
            if names.is_empty() || !pk.iter().all(|p| names.contains(p)) {
                continue;
            }
            names.sort_unstable();
            let mut vals: Vec<SqlValue> = names.iter().map(|n| to_sql(&obj[*n])).collect();
            let mut col_sql = names.join(",");
            let mut ph: Vec<String> = (1..=names.len()).map(|i| format!("?{i}")).collect();
            if synced {
                col_sql.push_str(",dirty");
                ph.push(format!("?{}", vals.len() + 1));
                vals.push(SqlValue::Integer(1));
            }
            let sql = if has_updated && !pk.is_empty() {
                let mut sets: Vec<String> =
                    names.iter().filter(|n| !pk.contains(n)).map(|n| format!("{n}=excluded.{n}")).collect();
                if synced {
                    sets.push("dirty=1".into());
                }
                format!(
                    "INSERT INTO {t}({col_sql}) VALUES({}) ON CONFLICT({}) DO UPDATE SET {} WHERE {t}.updated_at < excluded.updated_at",
                    ph.join(","),
                    pk.join(","),
                    sets.join(",")
                )
            } else {
                format!("INSERT OR IGNORE INTO {t}({col_sql}) VALUES({})", ph.join(","))
            };
            if tx.execute(&sql, params_from_iter(vals))? > 0 {
                report.changed += 1;
            } else {
                report.unchanged += 1;
            }
        }
    }
    tx.commit()?;
    Ok(report)
}

/// Reads a backup file: a JSON bundle, or a SQLite copy (exported or automatic).
pub fn load(path: &Path) -> Result<J> {
    let head = std::fs::read(path).map(|b| b.into_iter().take(16).collect::<Vec<u8>>())?;
    if head.starts_with(b"SQLite format 3") {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        return dump(&conn);
    }
    let text = std::fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(|_| "This file is not a BluePhoenix backup".into())
}

/// A consistent copy of the live database, safe to take while the app is running.
fn snapshot(conn: &Connection, to: &Path) -> Result<()> {
    if to.exists() {
        std::fs::remove_file(to)?;
    }
    conn.execute("VACUUM INTO ?1", [to.to_string_lossy()])?;
    Ok(())
}

pub fn export(db: &Db, to: &Path) -> Result<()> {
    let conn = db.0.lock_ok();
    let is_db = to.extension().is_some_and(|e| e == "db" || e == "sqlite");
    if is_db {
        snapshot(&conn, to)
    } else {
        let bundle = dump(&conn)?;
        drop(conn);
        std::fs::write(to, serde_json::to_string_pretty(&bundle)?)?;
        Ok(())
    }
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?.join("backups");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn list_in(dir: &Path) -> Vec<BackupFile> {
    let mut out: Vec<BackupFile> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("bluephoenix-") && e.path().extension().is_some_and(|x| x == "db"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let created = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
            Some(BackupFile {
                path: e.path().to_string_lossy().to_string(),
                name: e.file_name().to_string_lossy().to_string(),
                size: meta.len(),
                created_at: created,
            })
        })
        .collect();
    out.sort_by(|a, b| b.name.cmp(&a.name)); // names carry the date: newest first
    out
}

/// Takes today's automatic backup if there is none yet, and keeps only the newest `KEEP`.
/// Returns whether it took one.
pub fn daily(db: &Db, dir: &Path, today: &str) -> Result<bool> {
    let target = dir.join(format!("bluephoenix-{today}.db"));
    let took = if target.exists() {
        false
    } else {
        snapshot(&db.0.lock_ok(), &target)?;
        true
    };
    for old in list_in(dir).into_iter().skip(KEEP) {
        let _ = std::fs::remove_file(old.path);
    }
    Ok(took)
}

pub fn jobs() -> Vec<Job> {
    vec![Job::every("daily backup", Duration::from_secs(60), Duration::from_secs(60 * 60), |app| async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let dir = backups_dir(&app)?;
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            daily(&app.state::<Db>(), &dir, &today)
        })
        .await;
    })]
}

// ---------- commands ----------

#[tauri::command]
pub async fn backup_export(db: State<'_, Db>, path: String) -> Result<()> {
    export(&db, Path::new(&path))
}

#[tauri::command]
pub async fn backup_import(db: State<'_, Db>, path: String) -> Result<ImportReport> {
    let bundle = load(Path::new(&path))?;
    let mut conn = db.0.lock_ok();
    merge(&mut conn, &bundle)
}

#[tauri::command]
pub async fn backup_list(app: AppHandle) -> Result<Vec<BackupFile>> {
    Ok(list_in(&backups_dir(&app)?))
}

/// Takes a backup right now (named with the current time, so it never replaces the daily one).
#[tauri::command]
pub async fn backup_now(app: AppHandle, db: State<'_, Db>) -> Result<BackupFile> {
    let dir = backups_dir(&app)?;
    let name = format!("bluephoenix-{}.db", chrono::Local::now().format("%Y-%m-%d-%H%M%S"));
    snapshot(&db.0.lock_ok(), &dir.join(&name))?;
    list_in(&dir).into_iter().find(|b| b.name == name).ok_or_else(|| "The backup was not written".into())
}

#[tauri::command]
pub async fn backup_dir(app: AppHandle) -> Result<String> {
    Ok(backups_dir(&app)?.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("bp-backup-{name}-{}", uuid::Uuid::new_v4()))
    }

    fn db() -> Db {
        Db::open(&tmp("db").with_extension("db")).unwrap()
    }

    fn add_project(db: &Db, id: &str, name: &str, updated: i64) {
        db.0.lock_ok()
            .execute(
                "INSERT INTO projects(id,name,path,kind,created_at,updated_at,dirty) VALUES(?1,?2,'/x','Other',1,?3,0)
                 ON CONFLICT(id) DO UPDATE SET name=?2, updated_at=?3",
                params![id, name, updated],
            )
            .unwrap();
    }

    fn name_of(db: &Db, id: &str) -> Option<String> {
        db.0.lock_ok().query_row("SELECT name FROM projects WHERE id=?1", [id], |r| r.get(0)).ok()
    }

    #[test]
    fn json_round_trip_adds_missing_and_keeps_newer() {
        let (a, b) = (db(), db());
        add_project(&a, "p1", "From backup", 100);
        add_project(&a, "p2", "Old name", 100);
        add_project(&b, "p2", "Newer here", 200);
        let file = tmp("json").with_extension("json");
        export(&a, &file).unwrap();

        let bundle = load(&file).unwrap();
        let r = merge(&mut b.0.lock_ok(), &bundle).unwrap();
        assert_eq!(name_of(&b, "p1").as_deref(), Some("From backup"));
        assert_eq!(name_of(&b, "p2").as_deref(), Some("Newer here"), "never overwrite newer work");
        assert!(r.changed >= 1);
        let dirty: i64 = b.0.lock_ok().query_row("SELECT dirty FROM projects WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(dirty, 1, "imported rows sync to other devices");
    }

    #[test]
    fn sqlite_copy_can_be_imported() {
        let (a, b) = (db(), db());
        add_project(&a, "p1", "Snapshot", 100);
        let file = tmp("copy").with_extension("db");
        export(&a, &file).unwrap();
        merge(&mut b.0.lock_ok(), &load(&file).unwrap()).unwrap();
        assert_eq!(name_of(&b, "p1").as_deref(), Some("Snapshot"));
    }

    #[test]
    fn rejects_other_files() {
        let f = tmp("junk").with_extension("json");
        std::fs::write(&f, r#"{"hello":1}"#).unwrap();
        let b = db();
        assert!(merge(&mut b.0.lock_ok(), &load(&f).unwrap()).is_err());
    }

    #[test]
    fn daily_backup_once_per_day_and_keeps_a_week() {
        let a = db();
        let dir = tmp("dir");
        std::fs::create_dir_all(&dir).unwrap();
        for d in 1..=9 {
            assert!(daily(&a, &dir, &format!("2026-01-{d:02}")).unwrap());
        }
        assert!(!daily(&a, &dir, "2026-01-09").unwrap(), "only one per day");
        let left: Vec<String> = list_in(&dir).into_iter().map(|b| b.name).collect();
        assert_eq!(left.len(), KEEP);
        assert_eq!(left[0], "bluephoenix-2026-01-09.db");
        assert!(!left.contains(&"bluephoenix-2026-01-01.db".to_string()));
    }
}
