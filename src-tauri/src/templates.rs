//! The user's own templates for the New project wizard: a saved plan (steps with `{{name}}`-style
//! placeholders, plus the tools and commands it needs). The wizard turns it back into a plan, and the
//! backend checks every plan the same way before running it. Templates sync between computers and
//! can be shared as JSON files.

use std::path::Path;

use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{now, Db};
use crate::error::{err, LockExt, Result};

const FORMAT: &str = "bluephoenix-template";
const MAX_BODY: usize = 2_000_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub blurb: String,
    #[serde(default = "other")]
    pub kind: String,
    #[serde(default = "bookmark")]
    pub icon: String,
    /// The built-in template it was made from, if any.
    #[serde(default)]
    pub base_id: Option<String>,
    /// `{ steps, tools, commands, icons }`, as built by the wizard.
    pub body: serde_json::Value,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn other() -> String {
    "Other".into()
}
fn bookmark() -> String {
    "Bookmark".into()
}

fn from_row(r: &Row) -> rusqlite::Result<CustomTemplate> {
    let body: String = r.get("body")?;
    Ok(CustomTemplate {
        id: r.get("id")?,
        name: r.get("name")?,
        blurb: r.get("blurb")?,
        kind: r.get("kind")?,
        icon: r.get("icon")?,
        base_id: r.get("base_id")?,
        body: serde_json::from_str(&body).unwrap_or(serde_json::Value::Null),
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn check(t: &CustomTemplate) -> Result<()> {
    if t.name.trim().is_empty() {
        return err("Give the template a name");
    }
    let steps = t.body.get("steps").and_then(|s| s.as_array());
    if steps.is_none_or(|s| s.is_empty()) {
        return err("This template has no steps");
    }
    for s in steps.into_iter().flatten() {
        let kind = s.get("kind").and_then(|k| k.as_str()).unwrap_or_default();
        if !["run", "write", "jsonSet", "replace", "icons", "git"].contains(&kind) {
            return err(format!("Unknown step kind “{kind}”"));
        }
    }
    if t.body.to_string().len() > MAX_BODY {
        return err("This template is too large");
    }
    Ok(())
}

pub fn list(db: &Db) -> Result<Vec<CustomTemplate>> {
    let conn = db.0.lock_ok();
    let mut stmt = conn.prepare("SELECT * FROM project_templates WHERE deleted=0 ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn save(db: &Db, mut t: CustomTemplate) -> Result<CustomTemplate> {
    t.name = t.name.trim().to_string();
    t.blurb = t.blurb.trim().to_string();
    check(&t)?;
    let ts = now();
    if t.created_at == 0 {
        t.created_at = ts;
    }
    t.updated_at = ts;
    let conn = db.0.lock_ok();
    conn.execute(
        "INSERT INTO project_templates(id,name,blurb,kind,icon,base_id,body,created_at,updated_at,deleted,dirty)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0,1)
         ON CONFLICT(id) DO UPDATE SET name=?2,blurb=?3,kind=?4,icon=?5,base_id=?6,body=?7,updated_at=?9,deleted=0,dirty=1",
        params![t.id, t.name, t.blurb, t.kind, t.icon, t.base_id, t.body.to_string(), t.created_at, t.updated_at],
    )?;
    Ok(t)
}

#[tauri::command]
pub async fn templates_list(db: State<'_, Db>) -> Result<Vec<CustomTemplate>> {
    list(&db)
}

#[tauri::command]
pub async fn template_save(db: State<'_, Db>, template: CustomTemplate) -> Result<CustomTemplate> {
    save(&db, template)
}

#[tauri::command]
pub async fn template_delete(db: State<'_, Db>, id: String) -> Result<()> {
    let conn = db.0.lock_ok();
    conn.execute("UPDATE project_templates SET deleted=1, dirty=1, updated_at=?1 WHERE id=?2", params![now(), id])?;
    Ok(())
}

#[tauri::command]
pub async fn template_export(db: State<'_, Db>, id: String, path: String) -> Result<()> {
    let Some(t) = list(&db)?.into_iter().find(|t| t.id == id) else { return err("Template not found") };
    let mut v = serde_json::to_value(&t)?;
    if let Some(o) = v.as_object_mut() {
        o.insert("format".into(), FORMAT.into());
        o.insert("version".into(), 1.into());
        o.remove("createdAt");
        o.remove("updatedAt");
    }
    std::fs::write(Path::new(&path), serde_json::to_string_pretty(&v)?)?;
    Ok(())
}

/// Imports a shared template file as a new template (a fresh id, so it never overwrites one).
pub fn import(db: &Db, text: &str) -> Result<CustomTemplate> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|_| "This file is not a BluePhoenix template")?;
    if v.get("format").and_then(|f| f.as_str()) != Some(FORMAT) {
        return err("This file is not a BluePhoenix template");
    }
    let mut t: CustomTemplate = serde_json::from_value(v).map_err(|e| format!("This template could not be read: {e}"))?;
    t.id = uuid::Uuid::new_v4().to_string();
    t.created_at = 0;
    save(db, t)
}

#[tauri::command]
pub async fn template_import(db: State<'_, Db>, path: String) -> Result<CustomTemplate> {
    import(&db, &std::fs::read_to_string(&path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open(&std::env::temp_dir().join(format!("bp-tpl-{}.db", uuid::Uuid::new_v4()))).unwrap()
    }

    fn tpl(steps: serde_json::Value) -> CustomTemplate {
        CustomTemplate {
            id: "t1".into(),
            name: " My Vite ".into(),
            blurb: String::new(),
            kind: "React".into(),
            icon: "Atom".into(),
            base_id: Some("react".into()),
            body: serde_json::json!({ "steps": steps, "tools": ["npm"], "commands": [] }),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn saves_lists_exports_and_imports() {
        let db = db();
        let saved = save(&db, tpl(serde_json::json!([{ "kind": "run", "label": "Create", "program": "npm", "args": ["create", "vite@latest", "{{folder}}"] }]))).unwrap();
        assert_eq!(saved.name, "My Vite");
        assert_eq!(list(&db).unwrap().len(), 1);

        let file = std::env::temp_dir().join(format!("bp-tpl-{}.json", uuid::Uuid::new_v4()));
        let mut v = serde_json::to_value(list(&db).unwrap().remove(0)).unwrap();
        v["format"] = FORMAT.into();
        std::fs::write(&file, v.to_string()).unwrap();
        let imported = import(&db, &std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_ne!(imported.id, "t1", "imports never overwrite");
        assert_eq!(list(&db).unwrap().len(), 2);
    }

    #[test]
    fn rejects_bad_templates() {
        let db = db();
        assert!(save(&db, tpl(serde_json::json!([]))).is_err());
        assert!(save(&db, tpl(serde_json::json!([{ "kind": "sudo" }]))).is_err());
        assert!(import(&db, r#"{"name":"x"}"#).is_err());
        assert!(import(&db, "nope").is_err());
    }
}
