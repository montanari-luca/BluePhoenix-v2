//! Cloud sync over a user-supplied Postgres database (Neon by default).
//!
//! SQLite stays the source of truth on each device. Every synced row carries `updated_at`
//! (client clock, ms), a `deleted` tombstone and, locally, a `dirty` flag. On the server each row
//! also gets a `server_ts` assigned by the database clock, which is what devices page through when
//! pulling, so a device that was offline cannot miss rows. Conflicts are resolved last-write-wins on
//! `updated_at`.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::try_join_all;
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_postgres::config::SslMode;
use tokio_postgres::types::ToSql;
use tokio_postgres::{Client, Config, NoTls};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::ai::{secret_get, secret_set};
use crate::db::{now, Db};
use crate::error::{err, AppError, LockExt, Result};
use crate::scheduler::Job;

pub const URL_SECRET: &str = "sync:db_url";

#[derive(Clone, Copy, PartialEq)]
enum T {
    Text,
    Int,
    Bool,
}

struct Table {
    name: &'static str,
    cols: &'static [(&'static str, T)],
    /// Local-only NOT NULL columns that need a value when a row first arrives from the server.
    local_defaults: &'static [(&'static str, &'static str)],
}

/// Parents before children.
const TABLES: &[Table] = &[
    Table {
        name: "projects",
        cols: &[
            ("id", T::Text),
            ("name", T::Text),
            ("description", T::Text),
            ("kind", T::Text),
            ("favorite", T::Bool),
            ("github_url", T::Text),
            ("website_url", T::Text),
            ("created_at", T::Int),
            ("updated_at", T::Int),
            ("archived_at", T::Int),
        ],
        local_defaults: &[("path", "''")],
    },
    // Fork upstream settings. The check results in the same local table are per machine and never sync.
    Table {
        name: "fork_sync",
        cols: &[
            ("id", T::Text),
            ("project_id", T::Text),
            ("is_fork", T::Bool),
            ("upstream_remote", T::Text),
            ("upstream_url", T::Text),
            ("upstream_branch", T::Text),
            ("auto_check", T::Bool),
            ("interval_minutes", T::Int),
            ("auto_pull", T::Bool),
            ("updated_at", T::Int),
        ],
        local_defaults: &[],
    },
    // The user's own New project templates (`templates.rs`).
    Table {
        name: "project_templates",
        cols: &[
            ("id", T::Text),
            ("name", T::Text),
            ("blurb", T::Text),
            ("kind", T::Text),
            ("icon", T::Text),
            ("base_id", T::Text),
            ("body", T::Text),
            ("created_at", T::Int),
            ("updated_at", T::Int),
        ],
        local_defaults: &[],
    },
    // A git summary per project, written by the desktop (`git_share.rs`) and shown read-only on the iPhone.
    Table {
        name: "project_git",
        cols: &[
            ("id", T::Text),
            ("project_id", T::Text),
            ("branch", T::Text),
            ("state", T::Text),
            ("ahead", T::Int),
            ("behind", T::Int),
            ("changed", T::Int),
            ("last_commit_ts", T::Int),
            ("last_commit_subject", T::Text),
            ("commits", T::Text),
            ("updated_at", T::Int),
        ],
        local_defaults: &[],
    },
    Table {
        name: "todo_pages",
        cols: &[
            ("id", T::Text),
            ("project_id", T::Text),
            ("title", T::Text),
            ("markdown", T::Text),
            ("sort", T::Int),
            ("updated_at", T::Int),
        ],
        local_defaults: &[],
    },
    Table {
        name: "todos",
        cols: &[
            ("id", T::Text),
            ("project_id", T::Text),
            ("page_id", T::Text),
            ("title", T::Text),
            ("notes", T::Text),
            ("status", T::Text),
            ("priority", T::Int),
            ("due", T::Int),
            ("ai_prompt", T::Text),
            ("sort", T::Int),
            ("created_at", T::Int),
            ("completed_at", T::Int),
            ("updated_at", T::Int),
        ],
        local_defaults: &[],
    },
    Table {
        name: "commands",
        cols: &[
            ("id", T::Text),
            ("project_id", T::Text),
            ("label", T::Text),
            ("command", T::Text),
            ("cwd", T::Text),
            ("source", T::Text),
            ("sort", T::Int),
            ("updated_at", T::Int),
        ],
        local_defaults: &[],
    },
    Table {
        name: "time_entries",
        cols: &[
            ("id", T::Text),
            ("project_id", T::Text),
            ("todo_id", T::Text),
            ("minutes", T::Int),
            ("logged_at", T::Int),
            ("note", T::Text),
            ("updated_at", T::Int),
        ],
        local_defaults: &[],
    },
];

fn pg_name(t: &Table) -> String {
    format!("bp_{}", t.name)
}

/// Postgres DDL for every table (also documented for the iOS app, which reads the same schema).
pub fn schema_sql() -> String {
    let mut s = String::new();
    for t in TABLES {
        let cols: Vec<String> = t
            .cols
            .iter()
            .map(|(n, ty)| {
                let ty = match ty {
                    T::Text => "text",
                    T::Int => "bigint",
                    T::Bool => "boolean",
                };
                if *n == "id" { format!("id text PRIMARY KEY") } else { format!("{n} {ty}") }
            })
            .collect();
        s.push_str(&format!(
            "CREATE TABLE IF NOT EXISTS {p} ({c}, deleted boolean NOT NULL DEFAULT false, server_ts bigint NOT NULL DEFAULT 0);\nCREATE INDEX IF NOT EXISTS {p}_ts ON {p}(server_ts);\n",
            p = pg_name(t),
            c = cols.join(", ")
        ));
        // Columns added in later versions: tables created by an older app (or the iPhone) get them too.
        for c in cols.iter().skip(1) {
            s.push_str(&format!("ALTER TABLE {p} ADD COLUMN IF NOT EXISTS {c};\n", p = pg_name(t)));
        }
    }
    s
}

pub fn pg_message(e: &tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        return db.message().to_string();
    }
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        msg = format!("{msg}: {s}");
        src = s.source();
    }
    msg
}

fn pg<T2>(r: std::result::Result<T2, tokio_postgres::Error>) -> Result<T2> {
    r.map_err(|e| AppError::Msg(pg_message(&e)))
}

// ---------- connection ----------

pub fn parse_url(url: &str) -> Result<Config> {
    let url = url.trim();
    if !(url.starts_with("postgres://") || url.starts_with("postgresql://")) {
        return err("The address must start with postgresql://");
    }
    Config::from_str(url).map_err(|e| AppError::Msg(format!("That address could not be understood: {e}")))
}

pub fn host_of(url: &str) -> Option<String> {
    let cfg = Config::from_str(url.trim()).ok()?;
    cfg.get_hosts().iter().find_map(|h| match h {
        tokio_postgres::config::Host::Tcp(s) => Some(s.clone()),
        #[allow(unreachable_patterns)]
        _ => None,
    })
}

async fn connect(url: &str) -> Result<Client> {
    let config = parse_url(url)?;
    let fut = async {
        if matches!(config.get_ssl_mode(), SslMode::Disable) {
            let (client, conn) = config.connect(NoTls).await?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            Ok::<_, tokio_postgres::Error>(client)
        } else {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("TLS versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            let (client, conn) = config.connect(MakeRustlsConnect::new(cfg)).await?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            Ok(client)
        }
    };
    match tokio::time::timeout(Duration::from_secs(20), fut).await {
        Ok(r) => pg(r),
        Err(_) => err("Connecting to the database timed out"),
    }
}

async fn ensure_schema(client: &Client) -> Result<()> {
    pg(client.batch_execute(&schema_sql()).await)
}

// ---------- row values ----------

#[derive(Clone, Debug)]
enum V {
    T(Option<String>),
    I(Option<i64>),
    B(bool),
}

impl V {
    fn as_sql(&self) -> &(dyn ToSql + Sync) {
        match self {
            V::T(x) => x,
            V::I(x) => x,
            V::B(x) => x,
        }
    }
    fn to_sqlite(&self) -> SqlValue {
        match self {
            V::T(Some(s)) => SqlValue::Text(s.clone()),
            V::I(Some(i)) => SqlValue::Integer(*i),
            V::B(b) => SqlValue::Integer(*b as i64),
            _ => SqlValue::Null,
        }
    }
}

fn col_list(t: &Table) -> String {
    t.cols.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(",")
}

fn read_local(conn: &Connection, t: &Table) -> rusqlite::Result<Vec<Vec<V>>> {
    let sql = format!("SELECT {},deleted FROM {} WHERE dirty=1", col_list(t), t.name);
    let mut stmt = conn.prepare(&sql)?;
    let n = t.cols.len();
    let rows = stmt.query_map([], |r| {
        let mut v = Vec::with_capacity(n + 1);
        for (i, (_, ty)) in t.cols.iter().enumerate() {
            v.push(match ty {
                T::Text => V::T(r.get(i)?),
                T::Int => V::I(r.get(i)?),
                T::Bool => V::B(r.get::<_, i64>(i)? != 0),
            });
        }
        v.push(V::B(r.get::<_, i64>(n)? != 0));
        Ok(v)
    })?;
    rows.collect()
}

fn upsert_remote_sql(t: &Table) -> String {
    let p = pg_name(t);
    let n = t.cols.len();
    let placeholders: Vec<String> = (1..=n + 1).map(|i| format!("${i}")).collect();
    let sets: Vec<String> = t
        .cols
        .iter()
        .skip(1)
        .map(|(c, _)| format!("{c}=EXCLUDED.{c}"))
        .chain(["deleted=EXCLUDED.deleted".to_string(), "server_ts=EXCLUDED.server_ts".to_string()])
        .collect();
    format!(
        "INSERT INTO {p}({cols},deleted,server_ts) VALUES({ph},(extract(epoch from clock_timestamp())*1000)::bigint) \
         ON CONFLICT(id) DO UPDATE SET {sets} WHERE {p}.updated_at IS NULL OR {p}.updated_at <= EXCLUDED.updated_at",
        cols = col_list(t),
        ph = placeholders.join(","),
        sets = sets.join(",")
    )
}

fn upsert_local_sql(t: &Table) -> String {
    let n = t.cols.len();
    let placeholders: Vec<String> = (1..=n + 1).map(|i| format!("?{i}")).collect();
    let extra_cols: String = t.local_defaults.iter().map(|(c, _)| format!(",{c}")).collect();
    let extra_vals: String = t.local_defaults.iter().map(|(_, v)| format!(",{v}")).collect();
    let sets: Vec<String> = t
        .cols
        .iter()
        .skip(1)
        .map(|(c, _)| format!("{c}=excluded.{c}"))
        .chain(["deleted=excluded.deleted".to_string(), "dirty=0".to_string()])
        .collect();
    format!(
        "INSERT INTO {tn}({cols},deleted,dirty{ec}) VALUES({ph},0{ev}) ON CONFLICT(id) DO UPDATE SET {sets} WHERE {tn}.updated_at < excluded.updated_at",
        tn = t.name,
        cols = col_list(t),
        ph = placeholders.join(","),
        ec = extra_cols,
        ev = extra_vals,
        sets = sets.join(",")
    )
}

fn updated_at_idx(t: &Table) -> usize {
    t.cols.iter().position(|(n, _)| *n == "updated_at").unwrap()
}

async fn push_table(client: &Client, db: &Db, t: &Table) -> Result<usize> {
    let rows = {
        let conn = db.0.lock_ok();
        read_local(&conn, t)?
    };
    if rows.is_empty() {
        return Ok(0);
    }
    let stmt = pg(client.prepare(&upsert_remote_sql(t)).await)?;
    let mut rejected = vec![];
    for chunk in rows.chunks(40) {
        let futs = chunk.iter().map(|row| {
            let params: Vec<&(dyn ToSql + Sync)> = row.iter().map(|v| v.as_sql()).collect();
            let stmt = stmt.clone();
            async move { client.execute(&stmt, &params).await }
        });
        let counts = pg(try_join_all(futs).await)?;
        // 0 rows written: the server already has a newer version, so this local edit loses (last write
        // wins) and the pull below replaces it. Keep a copy so the user can see and restore it.
        rejected.extend(chunk.iter().zip(counts).filter(|(_, n)| *n == 0).map(|(row, _)| row));
    }
    if !rejected.is_empty() {
        let conn = db.0.lock_ok();
        for row in rejected {
            let _ = record_conflict(&conn, t, row);
        }
    }
    // Mark clean only rows that were not edited again while we were uploading.
    let ua = updated_at_idx(t);
    let mut conn = db.0.lock_ok();
    let tx = conn.transaction()?;
    for row in &rows {
        if let (V::T(Some(id)), V::I(Some(u))) = (&row[0], &row[ua]) {
            tx.execute(&format!("UPDATE {} SET dirty=0 WHERE id=?1 AND updated_at=?2", t.name), rusqlite::params![id, u])?;
        }
    }
    tx.commit()?;
    Ok(rows.len())
}

/// A row as `{column: value}` JSON, with `deleted` included.
fn row_json(t: &Table, row: &[V]) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::Value as J;
    let mut m = serde_json::Map::new();
    let names = t.cols.iter().map(|(n, _)| *n).chain(["deleted"]);
    for (name, v) in names.zip(row) {
        let j = match v {
            V::T(s) => s.clone().map(J::String).unwrap_or(J::Null),
            V::I(i) => i.map(J::from).unwrap_or(J::Null),
            V::B(b) => J::Bool(*b),
        };
        m.insert(name.to_string(), j);
    }
    m
}

fn record_conflict(conn: &Connection, t: &Table, row: &[V]) -> rusqlite::Result<()> {
    let json = row_json(t, row);
    let row_id = json.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let label = ["name", "title", "label", "command"]
        .iter()
        .find_map(|k| json.get(*k).and_then(|v| v.as_str()).map(str::to_string));
    conn.execute(
        "INSERT INTO sync_conflicts(id,table_name,row_id,label,local_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), t.name, row_id, label, serde_json::Value::Object(json).to_string(), now()],
    )?;
    Ok(())
}

fn cursor_key(t: &Table) -> String {
    format!("cursor:{}", t.name)
}

fn get_state(db: &Db, key: &str) -> Option<String> {
    let conn = db.0.lock_ok();
    conn.query_row("SELECT value FROM sync_state WHERE key=?1", [key], |r| r.get(0)).ok()
}

fn set_state(db: &Db, key: &str, value: &str) {
    let conn = db.0.lock_ok();
    let _ = conn.execute(
        "INSERT INTO sync_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
        rusqlite::params![key, value],
    );
}

async fn pull_table(client: &Client, db: &Db, t: &Table) -> Result<usize> {
    let cursor: i64 = get_state(db, &cursor_key(t)).and_then(|v| v.parse().ok()).unwrap_or(0);
    let sql = format!("SELECT {},deleted,server_ts FROM {} WHERE server_ts >= $1 ORDER BY server_ts", col_list(t), pg_name(t));
    let rows = pg(client.query(&sql, &[&cursor]).await)?;
    if rows.is_empty() {
        return Ok(0);
    }
    let n = t.cols.len();
    let mut decoded: Vec<Vec<V>> = Vec::with_capacity(rows.len());
    let mut max_ts = cursor;
    for r in &rows {
        let mut v = Vec::with_capacity(n + 1);
        for (i, (_, ty)) in t.cols.iter().enumerate() {
            v.push(match ty {
                T::Text => V::T(r.get(i)),
                T::Int => V::I(r.get(i)),
                T::Bool => V::B(r.get::<_, Option<bool>>(i).unwrap_or(false)),
            });
        }
        v.push(V::B(r.get(n)));
        max_ts = max_ts.max(r.get::<_, i64>(n + 1));
        decoded.push(v);
    }
    let sql = upsert_local_sql(t);
    let mut changed = 0;
    {
        let mut conn = db.0.lock_ok();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(&sql)?;
            for row in &decoded {
                changed += stmt.execute(params_from_iter(row.iter().map(|v| v.to_sqlite())))?;
            }
        }
        tx.commit()?;
    }
    set_state(db, &cursor_key(t), &max_ts.to_string());
    Ok(changed)
}

// ---------- public API ----------

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
}

#[derive(Default)]
pub struct SyncGuard(pub tokio::sync::Mutex<()>);

pub async fn run_sync(db: &Db, url: &str) -> Result<SyncReport> {
    let client = connect(url).await?;
    ensure_schema(&client).await?;
    let mut report = SyncReport::default();
    for t in TABLES {
        report.pushed += push_table(&client, db, t).await?;
    }
    for t in TABLES {
        report.pulled += pull_table(&client, db, t).await?;
    }
    set_state(db, "last_sync", &now().to_string());
    set_state(db, "last_error", "");
    Ok(report)
}

async fn sync_and_notify(app: &AppHandle) -> Result<SyncReport> {
    let guard = app.state::<SyncGuard>();
    let _lock = guard.0.lock().await;
    let db = app.state::<Db>();
    let url = secret_get(URL_SECRET).ok_or_else(|| AppError::Msg("Cloud sync is not connected".into()))?;
    let res = run_sync(&db, &url).await;
    match &res {
        Ok(r) => {
            let _ = app.emit("sync-finished", r.clone());
        }
        Err(e) => {
            set_state(&db, "last_error", &e.to_string());
            let _ = app.emit("sync-failed", e.to_string());
        }
    }
    res
}

/// For the shared scheduler: sync every minute while a database is connected.
pub fn jobs() -> Vec<Job> {
    vec![Job::every("cloud sync", Duration::from_secs(4), Duration::from_secs(60), |app| async move {
        if secret_get(URL_SECRET).is_some() {
            let _ = sync_and_notify(&app).await;
        }
    })]
}

// ---------- conflicts ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FieldDiff {
    pub field: String,
    /// The value this computer had (and lost).
    pub mine: serde_json::Value,
    /// The value now in use, from the newer edit.
    pub current: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub id: String,
    pub table: String,
    pub row_id: String,
    pub label: Option<String>,
    pub created_at: i64,
    /// Fields that differ between the lost version and the current one (`updated_at` left out).
    pub diffs: Vec<FieldDiff>,
}

fn table_named(name: &str) -> Option<&'static Table> {
    TABLES.iter().find(|t| t.name == name)
}

fn current_row(conn: &Connection, t: &Table, id: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let sql = format!("SELECT {},deleted FROM {} WHERE id=?1", col_list(t), t.name);
    conn.query_row(&sql, [id], |r| {
        let mut v = Vec::with_capacity(t.cols.len() + 1);
        for (i, (_, ty)) in t.cols.iter().enumerate() {
            v.push(match ty {
                T::Text => V::T(r.get(i)?),
                T::Int => V::I(r.get(i)?),
                T::Bool => V::B(r.get::<_, i64>(i)? != 0),
            });
        }
        v.push(V::B(r.get::<_, i64>(t.cols.len())? != 0));
        Ok(row_json(t, &v))
    })
    .ok()
}

pub fn list_conflicts(db: &Db) -> Result<Vec<SyncConflict>> {
    let conn = db.0.lock_ok();
    let mut stmt =
        conn.prepare("SELECT id,table_name,row_id,label,local_json,created_at FROM sync_conflicts ORDER BY created_at DESC")?;
    let raw = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?, r.get::<_, i64>(5)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = vec![];
    for (id, table, row_id, label, json, created_at) in raw {
        let mine: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&json).unwrap_or_default();
        let current = table_named(&table).and_then(|t| current_row(&conn, t, &row_id)).unwrap_or_default();
        let diffs = mine
            .iter()
            .filter(|(k, _)| k.as_str() != "updated_at")
            .filter(|(k, v)| current.get(*k) != Some(*v))
            .map(|(k, v)| FieldDiff { field: k.clone(), mine: v.clone(), current: current.get(k).cloned().unwrap_or(serde_json::Value::Null) })
            .collect();
        out.push(SyncConflict { id, table, row_id, label, created_at, diffs });
    }
    Ok(out)
}

fn json_to_sql(v: &serde_json::Value) -> SqlValue {
    match v {
        serde_json::Value::String(s) => SqlValue::Text(s.clone()),
        serde_json::Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or(SqlValue::Null),
        serde_json::Value::Bool(b) => SqlValue::Integer(*b as i64),
        _ => SqlValue::Null,
    }
}

/// Puts the lost version back as a fresh edit, so it wins on the next sync. Removes the conflict.
pub fn restore_conflict(db: &Db, id: &str) -> Result<()> {
    let conn = db.0.lock_ok();
    let (table, row_id, json): (String, String, String) =
        conn.query_row("SELECT table_name,row_id,local_json FROM sync_conflicts WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let Some(t) = table_named(&table) else { return err("That kind of item can no longer be restored") };
    let mine: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&json)?;
    let mut sets = vec![];
    let mut vals = vec![];
    for (c, _) in t.cols.iter().skip(1).filter(|(c, _)| *c != "updated_at") {
        if let Some(v) = mine.get(*c) {
            vals.push(json_to_sql(v));
            sets.push(format!("{c}=?{}", vals.len()));
        }
    }
    vals.push(SqlValue::Integer(mine.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false) as i64));
    sets.push(format!("deleted=?{}", vals.len()));
    // Newer than the version it replaces, even if that one came from a device whose clock runs ahead.
    let current: i64 = conn
        .query_row(&format!("SELECT updated_at FROM {} WHERE id=?1", t.name), [&row_id], |r| r.get(0))
        .unwrap_or(0);
    vals.push(SqlValue::Integer(now().max(current + 1)));
    sets.push(format!("updated_at=?{}", vals.len()));
    vals.push(SqlValue::Text(row_id));
    let sql = format!("UPDATE {} SET {},dirty=1 WHERE id=?{}", t.name, sets.join(","), vals.len());
    conn.execute(&sql, params_from_iter(vals))?;
    conn.execute("DELETE FROM sync_conflicts WHERE id=?1", [id])?;
    Ok(())
}

#[tauri::command]
pub async fn sync_conflicts(db: State<'_, Db>) -> Result<Vec<SyncConflict>> {
    list_conflicts(&db)
}

#[tauri::command]
pub async fn sync_conflict_restore(db: State<'_, Db>, id: String) -> Result<()> {
    restore_conflict(&db, &id)
}

/// `None` dismisses them all.
#[tauri::command]
pub async fn sync_conflict_dismiss(db: State<'_, Db>, id: Option<String>) -> Result<()> {
    let conn = db.0.lock_ok();
    match id {
        Some(id) => conn.execute("DELETE FROM sync_conflicts WHERE id=?1", [id])?,
        None => conn.execute("DELETE FROM sync_conflicts", [])?,
    };
    Ok(())
}

#[tauri::command]
pub async fn sync_test(url: String) -> Result<String> {
    let client = connect(&url).await?;
    let row = pg(client.query_one("SELECT version()", &[]).await)?;
    let v: String = row.get(0);
    Ok(v.split_whitespace().take(2).collect::<Vec<_>>().join(" "))
}

/// Saves the address in the keychain and runs a first full sync against this database.
#[tauri::command]
pub async fn sync_connect(app: AppHandle, url: String) -> Result<SyncReport> {
    let url = url.trim().to_string();
    sync_test(url.clone()).await?;
    secret_set(URL_SECRET.into(), url).await?;
    {
        // A (possibly different) database: start from scratch and upload everything.
        let db = app.state::<Db>();
        let conn = db.0.lock_ok();
        conn.execute("DELETE FROM sync_state", [])?;
        for t in TABLES {
            conn.execute(&format!("UPDATE {} SET dirty=1", t.name), [])?;
        }
    }
    sync_and_notify(&app).await
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncReport> {
    sync_and_notify(&app).await
}

#[tauri::command]
pub async fn sync_disconnect(app: AppHandle) -> Result<()> {
    secret_set(URL_SECRET.into(), String::new()).await?;
    let db: State<Db> = app.state();
    let conn = db.0.lock_ok();
    conn.execute("DELETE FROM sync_state", [])?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub connected: bool,
    pub host: Option<String>,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
}

#[tauri::command]
pub async fn sync_status(db: State<'_, Db>) -> Result<SyncStatus> {
    let url = secret_get(URL_SECRET);
    Ok(SyncStatus {
        connected: url.is_some(),
        host: url.as_deref().and_then(host_of),
        last_sync: get_state(&db, "last_sync").and_then(|v| v.parse().ok()),
        last_error: get_state(&db, "last_error").filter(|s| !s.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_covers_all_tables() {
        let s = schema_sql();
        for t in TABLES {
            assert!(s.contains(&format!("CREATE TABLE IF NOT EXISTS bp_{}", t.name)));
        }
        assert!(s.contains("server_ts bigint"));
    }

    #[test]
    fn sql_builders_are_consistent() {
        for t in TABLES {
            let remote = upsert_remote_sql(t);
            assert!(remote.contains(&format!("${}", t.cols.len() + 1)));
            assert!(!remote.contains(&format!("${}", t.cols.len() + 2)));
            let local = upsert_local_sql(t);
            assert!(local.contains(&format!("?{}", t.cols.len() + 1)));
        }
        assert!(upsert_local_sql(&TABLES[0]).contains(",path"));
    }

    #[test]
    fn parses_neon_style_urls() {
        let u = "postgresql://user:pw@ep-cool-123.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
        assert_eq!(host_of(u).as_deref(), Some("ep-cool-123.eu-central-1.aws.neon.tech"));
        assert!(parse_url("mysql://x").is_err());
    }
}

#[cfg(test)]
mod pg_integration {
    use super::*;
    use rusqlite::params;

    /// Both tests reset the same server tables, so they must not run at the same time.
    static PG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn device(tag: &str) -> Db {
        let path = std::env::temp_dir().join(format!("bp-sync-{tag}-{}.db", uuid::Uuid::new_v4()));
        Db::open(&path).unwrap()
    }

    fn one<T2: rusqlite::types::FromSql>(db: &Db, sql: &str) -> Option<T2> {
        db.0.lock_ok().query_row(sql, [], |r| r.get(0)).ok()
    }

    /// Needs a throw-away Postgres: BP_TEST_PG=postgresql://user@localhost:5544/postgres cargo test pg_integration
    #[tokio::test]
    async fn two_devices_converge() {
        let Ok(url) = std::env::var("BP_TEST_PG") else {
            eprintln!("BP_TEST_PG not set, skipping");
            return;
        };
        let _serial = PG_LOCK.lock().await;
        // Clean slate on the server.
        let c = connect(&url).await.unwrap();
        for t in TABLES {
            c.batch_execute(&format!("DROP TABLE IF EXISTS {}", pg_name(t))).await.unwrap();
        }

        let (a, b) = (device("a"), device("b"));
        let t0 = now();
        {
            let conn = a.0.lock_ok();
            conn.execute("INSERT INTO projects(id,name,path,kind,created_at,updated_at) VALUES('p1','Alpha','/a','Rust',?1,?1)", params![t0]).unwrap();
            conn.execute("INSERT INTO todos(id,project_id,title,created_at,updated_at) VALUES('t1','p1','First',?1,?1)", params![t0]).unwrap();
            conn.execute("INSERT INTO time_entries(id,project_id,minutes,logged_at,updated_at) VALUES('m1','p1',30,?1,?1)", params![t0]).unwrap();
        }
        let r = run_sync(&a, &url).await.unwrap();
        assert_eq!(r.pushed, 3);
        assert_eq!(one::<i64>(&a, "SELECT COUNT(*) FROM projects WHERE dirty=1"), Some(0));

        // Device B receives everything but keeps its own (empty) folder path.
        let r = run_sync(&b, &url).await.unwrap();
        assert_eq!(r.pulled, 3);
        assert_eq!(one::<String>(&b, "SELECT name FROM projects WHERE id='p1'").as_deref(), Some("Alpha"));
        assert_eq!(one::<String>(&b, "SELECT path FROM projects WHERE id='p1'").as_deref(), Some(""));
        assert_eq!(one::<i64>(&b, "SELECT minutes FROM time_entries WHERE id='m1'"), Some(30));

        // B edits the to-do later than A's version; A must adopt it.
        {
            let conn = b.0.lock_ok();
            conn.execute("UPDATE todos SET title='First (edited on B)', status='done', updated_at=?1, dirty=1 WHERE id='t1'", params![t0 + 5000]).unwrap();
        }
        run_sync(&b, &url).await.unwrap();
        run_sync(&a, &url).await.unwrap();
        assert_eq!(one::<String>(&a, "SELECT title FROM todos WHERE id='t1'").as_deref(), Some("First (edited on B)"));
        assert_eq!(one::<String>(&a, "SELECT status FROM todos WHERE id='t1'").as_deref(), Some("done"));

        // Conflicting edits: the newer write wins on both devices.
        {
            a.0.lock_ok().execute("UPDATE todos SET title='A wins?', updated_at=?1, dirty=1 WHERE id='t1'", params![t0 + 9000]).unwrap();
            b.0.lock_ok().execute("UPDATE todos SET title='B is newer', updated_at=?1, dirty=1 WHERE id='t1'", params![t0 + 20000]).unwrap();
        }
        run_sync(&a, &url).await.unwrap();
        run_sync(&b, &url).await.unwrap();
        run_sync(&a, &url).await.unwrap();
        assert_eq!(one::<String>(&a, "SELECT title FROM todos WHERE id='t1'").as_deref(), Some("B is newer"));
        assert_eq!(one::<String>(&b, "SELECT title FROM todos WHERE id='t1'").as_deref(), Some("B is newer"));

        // Deleting on A propagates as a tombstone.
        {
            a.0.lock_ok().execute("UPDATE time_entries SET deleted=1, dirty=1, updated_at=?1 WHERE id='m1'", params![t0 + 30000]).unwrap();
        }
        run_sync(&a, &url).await.unwrap();
        run_sync(&b, &url).await.unwrap();
        assert_eq!(one::<i64>(&b, "SELECT deleted FROM time_entries WHERE id='m1'"), Some(1));

        // An offline edit on A that is older than B's already-synced edit loses, but is kept as a
        // conflict that A can restore.
        {
            b.0.lock_ok().execute("UPDATE todos SET title='B synced first', updated_at=?1, dirty=1 WHERE id='t1'", params![t0 + 50000]).unwrap();
            a.0.lock_ok().execute("UPDATE todos SET title='A offline', notes='mine', updated_at=?1, dirty=1 WHERE id='t1'", params![t0 + 40000]).unwrap();
        }
        run_sync(&b, &url).await.unwrap();
        run_sync(&a, &url).await.unwrap();
        assert_eq!(one::<String>(&a, "SELECT title FROM todos WHERE id='t1'").as_deref(), Some("B synced first"));
        let conflicts = list_conflicts(&a).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].table, "todos");
        assert_eq!(conflicts[0].label.as_deref(), Some("A offline"));
        assert!(conflicts[0].diffs.iter().any(|d| d.field == "title" && d.mine == "A offline" && d.current == "B synced first"));
        restore_conflict(&a, &conflicts[0].id).unwrap();
        assert!(list_conflicts(&a).unwrap().is_empty());
        run_sync(&a, &url).await.unwrap();
        run_sync(&b, &url).await.unwrap();
        assert_eq!(one::<String>(&b, "SELECT title FROM todos WHERE id='t1'").as_deref(), Some("A offline"));
        assert_eq!(one::<String>(&b, "SELECT notes FROM todos WHERE id='t1'").as_deref(), Some("mine"));

        // Archiving, fork settings and the git summary reach the other device; fork results stay local.
        {
            let conn = a.0.lock_ok();
            conn.execute("UPDATE projects SET archived_at=?1, updated_at=?1, dirty=1 WHERE id='p1'", params![t0 + 60000]).unwrap();
            conn.execute(
                "INSERT INTO fork_sync(id,project_id,is_fork,upstream_url,auto_check,status,behind,updated_at,dirty)
                 VALUES('p1','p1',1,'https://github.com/o/r',1,'safe',4,?1,1)",
                params![t0 + 60000],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO project_git(id,project_id,branch,state,changed,commits,updated_at) VALUES('p1','p1','main','dirty',2,'[]',?1)",
                params![t0 + 60000],
            )
            .unwrap();
        }
        run_sync(&a, &url).await.unwrap();
        run_sync(&b, &url).await.unwrap();
        assert_eq!(one::<i64>(&b, "SELECT archived_at FROM projects WHERE id='p1'"), Some(t0 + 60000));
        assert_eq!(one::<String>(&b, "SELECT upstream_url FROM fork_sync WHERE project_id='p1'").as_deref(), Some("https://github.com/o/r"));
        assert_eq!(one::<i64>(&b, "SELECT behind FROM fork_sync WHERE project_id='p1'"), Some(0), "check results are per machine");
        assert_eq!(one::<String>(&b, "SELECT branch FROM project_git WHERE id='p1'").as_deref(), Some("main"));

        // Nothing left to do: a further sync pushes nothing.
        assert_eq!(run_sync(&a, &url).await.unwrap().pushed, 0);
    }

    /// A server created by an older app version gets the new columns added in place.
    #[tokio::test]
    async fn upgrades_an_old_server_schema() {
        let Ok(url) = std::env::var("BP_TEST_PG") else { return };
        let _serial = PG_LOCK.lock().await;
        let c = connect(&url).await.unwrap();
        for t in TABLES {
            c.batch_execute(&format!("DROP TABLE IF EXISTS {}", pg_name(t))).await.unwrap();
        }
        c.batch_execute(
            "CREATE TABLE bp_projects (id text PRIMARY KEY, name text, description text, kind text, favorite boolean,
               github_url text, website_url text, created_at bigint, updated_at bigint,
               deleted boolean NOT NULL DEFAULT false, server_ts bigint NOT NULL DEFAULT 0)",
        )
        .await
        .unwrap();
        let a = device("old");
        a.0.lock_ok()
            .execute("INSERT INTO projects(id,name,path,kind,created_at,updated_at,archived_at) VALUES('p','P','/p','Rust',1,1,5)", [])
            .unwrap();
        run_sync(&a, &url).await.unwrap();
        let row = c.query_one("SELECT archived_at FROM bp_projects WHERE id='p'", &[]).await.unwrap();
        assert_eq!(row.get::<_, Option<i64>>(0), Some(5));
    }
}
