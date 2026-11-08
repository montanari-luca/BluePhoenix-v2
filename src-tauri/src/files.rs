use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::error::{err, LockExt, Result};

const MAX_FILES: usize = 100_000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub rel_path: String,
    pub size: i64,
    pub mtime: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub count: usize,
    pub truncated: bool,
}

/// Walks the project (respecting .gitignore) and stores every file in the local index.
#[tauri::command]
pub async fn files_index(db: State<'_, Db>, project_id: String, path: String) -> Result<IndexResult> {
    let root = Path::new(&path).to_path_buf();
    if !root.is_dir() {
        return err("Project folder not found");
    }
    let (entries, truncated) = tokio::task::spawn_blocking(move || scan_files(&root)).await.map_err(|e| e.to_string())?;
    store_files(&db, &project_id, &entries)?;
    Ok(IndexResult { count: entries.len(), truncated })
}

/// Lists every file under `root` (respecting .gitignore); the bool tells whether the list was cut short.
pub fn scan_files(root: &Path) -> (Vec<FileEntry>, bool) {
    let mut v: Vec<FileEntry> = vec![];
    let mut truncated = false;
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git" && e.file_name() != "node_modules")
        .build();
    for e in walker.flatten() {
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if v.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let Ok(rel) = e.path().strip_prefix(root) else { continue };
        let md = e.metadata().ok();
        v.push(FileEntry {
            rel_path: rel.to_string_lossy().replace('\\', "/"),
            size: md.as_ref().map(|m| m.len() as i64).unwrap_or(0),
            mtime: md
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        });
    }
    (v, truncated)
}

pub fn store_files(db: &Db, project_id: &str, entries: &[FileEntry]) -> Result<()> {
    let mut conn = db.0.lock_ok();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM files WHERE project_id=?1", params![project_id])?;
    {
        let mut stmt = tx.prepare("INSERT OR REPLACE INTO files(project_id,rel_path,size,mtime) VALUES(?1,?2,?3,?4)")?;
        for f in entries {
            stmt.execute(params![project_id, f.rel_path, f.size, f.mtime])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub async fn files_list(
    db: State<'_, Db>,
    project_id: String,
    query: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<FileEntry>> {
    let conn = db.0.lock_ok();
    let q = format!("%{}%", query.unwrap_or_default().replace('%', "\\%").replace('_', "\\_"));
    let mut stmt = conn.prepare(
        "SELECT rel_path,size,mtime FROM files WHERE project_id=?1 AND rel_path LIKE ?2 ESCAPE '\\'
         ORDER BY rel_path COLLATE NOCASE LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![project_id, q, limit.unwrap_or(500)], |r| {
            Ok(FileEntry { rel_path: r.get(0)?, size: r.get(1)?, mtime: r.get(2)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[tauri::command]
pub async fn files_count(db: State<'_, Db>, project_id: String) -> Result<i64> {
    let conn = db.0.lock_ok();
    Ok(conn.query_row("SELECT COUNT(*) FROM files WHERE project_id=?1", params![project_id], |r| r.get(0))?)
}
