//! Search across every project for the command palette: to-dos (title and notes), note pages,
//! commands and indexed file paths. Plain case-insensitive substring matching in SQLite, which is
//! instant for the amounts of data a person has.

use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::error::{LockExt, Result};

const SNIPPET: usize = 90;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// todo | page | command | file
    pub kind: String,
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub title: String,
    /// Text around the match when it was not in the title.
    pub snippet: Option<String>,
}

/// `%` and `_` are wildcards in LIKE; escape them so they match literally.
fn like(q: &str) -> String {
    let esc = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{esc}%")
}

/// A short excerpt of `text` around the first match of `q` (case-insensitive), on char boundaries.
pub fn snippet(text: &str, q: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let at = lower.find(&q.to_lowercase())?;
    // Map the byte offset in the lowercased text back to a char index (lowercasing can change lengths).
    let char_at = lower[..at].chars().count();
    let chars: Vec<char> = text.chars().collect();
    let start = char_at.saturating_sub(SNIPPET / 3);
    let end = (start + SNIPPET).min(chars.len());
    let mut s: String = chars[start..end].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s.push('…');
    }
    Some(s)
}

pub fn search(db: &Db, query: &str, limit: usize) -> Result<Vec<Hit>> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Ok(vec![]);
    }
    let pat = like(q);
    let conn = db.0.lock_ok();
    let per = limit.max(1) as i64;
    let mut hits = vec![];
    let queries: [(&str, &str); 4] = [
        (
            "todo",
            "SELECT t.id, t.project_id, p.name, t.title, t.notes FROM todos t JOIN projects p ON p.id=t.project_id AND p.deleted=0
             WHERE t.deleted=0 AND (t.title LIKE ?1 ESCAPE '\\' OR t.notes LIKE ?1 ESCAPE '\\')
             ORDER BY (t.status='done'), (t.title LIKE ?1 ESCAPE '\\') DESC, t.updated_at DESC LIMIT ?2",
        ),
        (
            "page",
            "SELECT g.id, g.project_id, p.name, g.title, g.markdown FROM todo_pages g JOIN projects p ON p.id=g.project_id AND p.deleted=0
             WHERE g.deleted=0 AND (g.title LIKE ?1 ESCAPE '\\' OR g.markdown LIKE ?1 ESCAPE '\\')
             ORDER BY (g.title LIKE ?1 ESCAPE '\\') DESC, g.updated_at DESC LIMIT ?2",
        ),
        (
            "command",
            "SELECT c.id, c.project_id, p.name, c.label, c.command FROM commands c JOIN projects p ON p.id=c.project_id AND p.deleted=0
             WHERE c.deleted=0 AND (c.label LIKE ?1 ESCAPE '\\' OR c.command LIKE ?1 ESCAPE '\\')
             ORDER BY c.sort LIMIT ?2",
        ),
        (
            "file",
            "SELECT f.rel_path, f.project_id, p.name, f.rel_path, NULL FROM files f JOIN projects p ON p.id=f.project_id AND p.deleted=0
             WHERE f.rel_path LIKE ?1 ESCAPE '\\'
             ORDER BY length(f.rel_path) LIMIT ?2",
        ),
    ];
    for (kind, sql) in queries {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params![pat, per], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?))
        })?;
        for row in rows {
            let (id, project_id, project_name, title, body) = row?;
            let in_title = title.to_lowercase().contains(&q.to_lowercase());
            let snip = if in_title && kind != "command" { None } else { body.as_deref().and_then(|b| snippet(b, q)) };
            hits.push(Hit { kind: kind.into(), id, project_id, project_name, title, snippet: snip });
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn search_all(db: State<'_, Db>, query: String, limit: Option<usize>) -> Result<Vec<Hit>> {
    search(&db, &query, limit.unwrap_or(8).min(50))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let db = Db::open(&std::env::temp_dir().join(format!("bp-search-{}.db", uuid::Uuid::new_v4()))).unwrap();
        {
            let c = db.0.lock_ok();
            c.execute_batch(
                "INSERT INTO projects(id,name,path,created_at,updated_at) VALUES('p','Shop','/s',1,1);
                 INSERT INTO projects(id,name,path,created_at,updated_at,deleted) VALUES('gone','Old','/o',1,1,1);
                 INSERT INTO todos(id,project_id,title,notes,created_at,updated_at) VALUES('t1','p','Fix checkout','Stripe webhook retries fail at 100%',1,1);
                 INSERT INTO todos(id,project_id,title,created_at,updated_at) VALUES('t2','gone','checkout in old project',1,1);
                 INSERT INTO todo_pages(id,project_id,title,markdown,updated_at) VALUES('g','p','Roadmap','Q1: new checkout flow',1);
                 INSERT INTO commands(id,project_id,label,command,updated_at) VALUES('c','p','Dev','pnpm dev --host',1);
                 INSERT INTO files(project_id,rel_path) VALUES('p','src/checkout/Cart.tsx');",
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn finds_across_kinds_and_skips_deleted_projects() {
        let db = db();
        let hits = search(&db, "checkout", 10).unwrap();
        let kinds: Vec<&str> = hits.iter().map(|h| h.kind.as_str()).collect();
        assert_eq!(kinds, vec!["todo", "page", "file"]);
        assert!(hits.iter().all(|h| h.project_id == "p"));
        assert_eq!(hits[1].snippet.as_deref(), Some("Q1: new checkout flow"));
        assert!(hits[0].snippet.is_none(), "title match needs no snippet");
    }

    #[test]
    fn matches_notes_and_commands_and_escapes_wildcards() {
        let db = db();
        let notes = search(&db, "webhook", 10).unwrap();
        assert_eq!(notes.len(), 1);
        assert!(notes[0].snippet.as_deref().unwrap().contains("webhook"));
        assert_eq!(search(&db, "--host", 10).unwrap()[0].kind, "command");
        assert_eq!(search(&db, "100%", 10).unwrap().len(), 1);
        assert!(search(&db, "0_", 10).unwrap().is_empty(), "_ is literal");
        assert!(search(&db, "c", 10).unwrap().is_empty(), "too short");
    }

    #[test]
    fn snippets_handle_unicode() {
        let s = snippet("Ünïcödé text with Straße and more words after the match point here", "straße").unwrap();
        assert!(s.contains("Straße"));
        assert!(snippet("abc", "zz").is_none());
    }
}
