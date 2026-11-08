//! Bulk import: find every git repository under a folder and add the chosen ones as projects.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::cli::{add_folder, AddOutcome};
use crate::db::{list_projects, Db};
use crate::detect;
use crate::error::Result;

/// Folders never worth descending into while looking for repositories.
const SKIP: &[&str] = &["node_modules", "target", "dist", "build", ".venv", "venv", "Pods", "DerivedData", ".cache", "vendor", "Library"];
const MAX_REPOS: usize = 500;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepo {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub description: Option<String>,
    /// Already a project in BluePhoenix.
    pub added: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<(String, String)>,
}

/// Repository folders under `root`, at most `depth` levels down. A repository's own subfolders are
/// not searched (submodules and vendored repos stay part of their parent).
pub fn find_repos(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, level)) = stack.pop() {
        if out.len() >= MAX_REPOS {
            break;
        }
        if dir.join(".git").exists() {
            out.push(dir);
            continue;
        }
        if level >= depth {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut subs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                !n.starts_with('.') && !SKIP.contains(&n.as_str())
            })
            .map(|e| e.path())
            .collect();
        subs.sort();
        stack.extend(subs.into_iter().rev().map(|p| (p, level + 1)));
    }
    out.sort();
    out
}

fn same(a: &str, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => Path::new(a) == b,
    }
}

#[tauri::command]
pub async fn import_scan(db: State<'_, Db>, root: String, depth: Option<usize>) -> Result<Vec<FoundRepo>> {
    let root = PathBuf::from(root);
    let depth = depth.unwrap_or(3).clamp(1, 6);
    let repos = tauri::async_runtime::spawn_blocking(move || find_repos(&root, depth)).await.map_err(|e| e.to_string())?;
    let existing: Vec<String> = list_projects(&db)?.into_iter().map(|s| s.project.path).collect();
    Ok(repos
        .into_iter()
        .map(|p| {
            let d = detect::detect_dir(&p);
            let fallback = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            FoundRepo {
                added: existing.iter().any(|e| same(e, &p)),
                path: p.to_string_lossy().to_string(),
                name: if d.name.trim().is_empty() { fallback } else { d.name },
                kind: d.kind,
                description: d.description,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn import_add(db: State<'_, Db>, paths: Vec<String>) -> Result<ImportResult> {
    let mut r = ImportResult::default();
    for p in paths {
        match add_folder(&db, Path::new(&p)).await {
            Ok(AddOutcome::Added { project, .. }) => r.added.push(project.id),
            Ok(AddOutcome::Exists { name }) => r.skipped.push(name),
            Err(e) => r.failed.push((p, e.to_string())),
        }
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_repos_but_not_inside_them_or_in_skipped_folders() {
        let root = std::env::temp_dir().join(format!("bp-import-{}", uuid::Uuid::new_v4()));
        for d in ["a/.git", "a/inner/.git", "group/b/.git", "group/deep/deeper/c/.git", "node_modules/x/.git", ".hidden/y/.git", "plain/src"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("group/wt"), "").unwrap();
        let found: Vec<String> = find_repos(&root, 3).iter().map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(found, vec!["a", "group/b"]);
        let deeper: Vec<String> = find_repos(&root, 4).iter().map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().to_string()).collect();
        assert!(deeper.contains(&"group/deep/deeper/c".to_string()));
    }

    #[tokio::test]
    async fn adds_folders_once() {
        let db = Db::open(&std::env::temp_dir().join(format!("bp-import-{}.db", uuid::Uuid::new_v4()))).unwrap();
        let dir = std::env::temp_dir().join(format!("bp-import-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"demo","scripts":{"dev":"vite"}}"#).unwrap();
        assert!(matches!(add_folder(&db, &dir).await.unwrap(), AddOutcome::Added { .. }));
        assert!(matches!(add_folder(&db, &dir).await.unwrap(), AddOutcome::Exists { .. }));
        assert_eq!(list_projects(&db).unwrap().len(), 1);
    }
}
