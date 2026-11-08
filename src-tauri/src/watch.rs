//! Watches each project's git metadata and tells the UI when it changed, so cards update right after
//! a commit, checkout, fetch or stage made anywhere (another terminal, an editor), without polling.
//!
//! Only `.git` itself (HEAD, index, FETCH_HEAD, packed-refs…, not recursive) and `refs/` are watched,
//! never the working tree: that stays cheap for big repos. Edits to working files are picked up by
//! the UI's focus refresh instead. Events are debounced and sent as `git-changed` with project ids.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{active_projects, Db};
use crate::error::{LockExt, Result};
use crate::scheduler::Job;

const DEBOUNCE: Duration = Duration::from_millis(400);
/// Re-check which projects exist and fix up watches (added, removed, moved, `git init`).
const RESYNC_EVERY: Duration = Duration::from_secs(30);

/// One watched path, the project it belongs to, and whether it is the working tree (for
/// file-change automations) rather than git metadata.
type Routes = Arc<Mutex<Vec<(PathBuf, String, bool)>>>;

/// Folders inside a working tree whose changes never count as "files changed".
const TREE_SKIP: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".venv", "venv", "__pycache__", ".turbo", ".cache", "DerivedData", "Pods"];

#[derive(Default)]
pub struct GitWatch(Mutex<Option<Inner>>);

/// (project path, whether its working tree is watched too, the paths watched for it)
type Watched = (String, bool, Vec<(PathBuf, RecursiveMode)>);

struct Inner {
    debouncer: Debouncer<RecommendedWatcher>,
    /// project id -> what is watched for it
    watched: HashMap<String, Watched>,
    routes: Routes,
}

/// The paths to watch for a working tree, handling linked worktrees and submodules where `.git` is a
/// file pointing elsewhere. `None` when the folder is not a git repository.
pub fn watch_targets(project: &Path) -> Option<Vec<(PathBuf, RecursiveMode)>> {
    let dot = project.join(".git");
    let git_dir = if dot.is_dir() {
        dot
    } else if dot.is_file() {
        let text = std::fs::read_to_string(&dot).ok()?;
        let rel = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
        let p = PathBuf::from(rel);
        if p.is_absolute() {
            p
        } else {
            project.join(p)
        }
    } else {
        return None;
    };
    if !git_dir.is_dir() {
        return None;
    }
    // Linked worktrees keep shared refs in the main repository ("commondir").
    let common = std::fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|c| {
            let p = PathBuf::from(c.trim());
            if p.is_absolute() {
                p
            } else {
                git_dir.join(p)
            }
        })
        .filter(|p| p.is_dir());
    let mut out = vec![(git_dir.clone(), RecursiveMode::NonRecursive)];
    let refs_root = common.clone().unwrap_or_else(|| git_dir.clone());
    if let Some(c) = &common {
        out.push((c.clone(), RecursiveMode::NonRecursive)); // packed-refs, FETCH_HEAD of the main repo
    }
    if refs_root.join("refs").is_dir() {
        out.push((refs_root.join("refs"), RecursiveMode::Recursive));
    }
    Some(out)
}

/// Git writes `*.lock` files around every change; the real file changes right after, so skip them.
fn is_noise(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "lock")
}

/// Which projects a batch of changed paths belongs to (git metadata routes only).
fn projects_for(routes: &[(PathBuf, String, bool)], paths: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
    let mut ids = HashSet::new();
    for path in paths {
        if is_noise(&path) {
            continue;
        }
        for (root, id, tree) in routes {
            if !tree && path.starts_with(root) {
                ids.insert(id.clone());
            }
        }
    }
    let mut v: Vec<String> = ids.into_iter().collect();
    v.sort();
    v
}

/// Working-tree changes per project, as `/`-separated paths relative to the project folder.
fn files_for(routes: &[(PathBuf, String, bool)], paths: &[PathBuf]) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for path in paths {
        for (root, id, tree) in routes {
            let Some(rel) = path.strip_prefix(root).ok().filter(|_| *tree) else { continue };
            let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
            if parts.is_empty() || parts.iter().any(|p| TREE_SKIP.contains(&p.as_str())) {
                continue;
            }
            let rel = parts.join("/");
            let list = out.entry(id.clone()).or_default();
            if !list.contains(&rel) {
                list.push(rel);
            }
        }
    }
    out
}

fn start(app: &AppHandle) -> Result<Inner> {
    let routes: Routes = Arc::default();
    let r = routes.clone();
    let handle = app.clone();
    let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let paths: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
        let (ids, files) = {
            let routes = r.lock_ok();
            (projects_for(&routes, paths.iter().cloned()), files_for(&routes, &paths))
        };
        for (id, changed) in files {
            crate::automation_runtime::on_files(&handle, &id, changed);
        }
        if !ids.is_empty() {
            crate::git_share::changed(&handle, &ids);
            crate::activity::changed(&handle, &ids);
            crate::automation_runtime::on_git_changed(&handle, &ids);
            let _ = handle.emit("git-changed", ids);
        }
    })
    .map_err(|e| format!("Could not start the git watcher: {e}"))?;
    Ok(Inner { debouncer, watched: HashMap::new(), routes })
}

/// Makes the watches match the projects in the database.
pub fn sync(app: &AppHandle) -> Result<()> {
    let wanted: HashMap<String, String> = active_projects(&app.state::<Db>())?
        .into_iter()
        .filter(|s| !s.project.path.is_empty())
        .map(|s| (s.project.id, s.project.path))
        .collect();
    // Working trees are watched only for projects that have a file-change automation.
    let tree: HashSet<String> = crate::automations::watched_projects(&app.state::<Db>(), "files").into_iter().collect();
    let state = app.state::<GitWatch>();
    let mut guard = state.0.lock_ok();
    if guard.is_none() {
        *guard = Some(start(app)?);
    }
    let inner = guard.as_mut().expect("just started");

    // Drop watches for removed or moved projects.
    let stale: Vec<String> = inner
        .watched
        .iter()
        .filter(|(id, (path, t, _))| wanted.get(*id) != Some(path) || *t != tree.contains(*id))
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        if let Some((_, _, targets)) = inner.watched.remove(&id) {
            for (p, _) in targets {
                let _ = inner.debouncer.watcher().unwatch(&p);
            }
        }
    }
    // Add new ones (also retries folders that were not repositories yet).
    for (id, path) in &wanted {
        if inner.watched.contains_key(id) {
            continue;
        }
        let Some(mut targets) = watch_targets(Path::new(path)) else { continue };
        let with_tree = tree.contains(id);
        if with_tree {
            targets.push((PathBuf::from(path), RecursiveMode::Recursive));
        }
        let mut ok = vec![];
        for (p, mode) in targets {
            if inner.debouncer.watcher().watch(&p, mode).is_ok() {
                ok.push((p, mode));
            }
        }
        if !ok.is_empty() {
            inner.watched.insert(id.clone(), (path.clone(), with_tree, ok));
        }
    }
    *inner.routes.lock_ok() = inner
        .watched
        .iter()
        .flat_map(|(id, (path, with_tree, t))| {
            let root = PathBuf::from(path);
            t.iter().map(move |(p, _)| (p.clone(), id.clone(), *with_tree && *p == root))
        })
        .collect();
    Ok(())
}

pub fn jobs() -> Vec<Job> {
    vec![Job::every("git watchers", Duration::from_secs(1), RESYNC_EVERY, |app| async move {
        let _ = tauri::async_runtime::spawn_blocking(move || sync(&app)).await;
    })]
}

/// Called by the UI after the project list changed, so a new project is watched right away.
#[tauri::command]
pub async fn git_watch_sync(app: AppHandle, _state: State<'_, GitWatch>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || sync(&app)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bp-watch-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn plain_repo_watches_git_dir_and_refs() {
        let d = tmp("plain");
        std::fs::create_dir_all(d.join(".git/refs/heads")).unwrap();
        let t = watch_targets(&d).unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].0, d.join(".git"));
        assert_eq!(t[1].0, d.join(".git/refs"));
        assert!(matches!(t[1].1, RecursiveMode::Recursive));
    }

    #[test]
    fn linked_worktree_follows_gitdir_and_commondir() {
        let main = tmp("main");
        std::fs::create_dir_all(main.join(".git/refs/heads")).unwrap();
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        let wt = tmp("wt");
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/wt").display())).unwrap();
        let t = watch_targets(&wt).unwrap();
        let paths: Vec<_> = t.iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(paths[0], main.join(".git/worktrees/wt"));
        assert!(paths.iter().any(|p| p.ends_with("refs")));
    }

    #[test]
    fn not_a_repo_has_no_targets() {
        assert!(watch_targets(&tmp("none")).is_none());
    }

    #[test]
    fn a_real_commit_is_reported_for_its_project() {
        use std::process::Command;
        let d = tmp("real");
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&d)
                .args(["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(d.join("a.txt"), "1").unwrap();
        // Canonical paths: on macOS the temp dir is a symlink and events arrive with the real path.
        let root = d.canonicalize().unwrap();
        let targets = watch_targets(&root).unwrap();
        let routes: Vec<_> = targets.iter().map(|(p, _)| (p.clone(), "p1".to_string(), false)).collect();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut deb = new_debouncer(Duration::from_millis(100), move |res: DebounceEventResult| {
            if let Ok(ev) = res {
                let _ = tx.send(projects_for(&routes, ev.into_iter().map(|e| e.path)));
            }
        })
        .unwrap();
        for (p, mode) in &targets {
            deb.watcher().watch(p, *mode).unwrap();
        }
        std::thread::sleep(Duration::from_millis(300)); // let the OS watcher settle
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "first"]);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut seen = false;
        while std::time::Instant::now() < deadline && !seen {
            if let Ok(ids) = rx.recv_timeout(Duration::from_millis(500)) {
                seen = ids == vec!["p1".to_string()];
            }
        }
        assert!(seen, "no git-changed for the commit");
    }

    #[test]
    fn routes_changes_to_projects_and_skips_lock_files() {
        let routes = vec![
            (PathBuf::from("/a/.git"), "a".to_string(), false),
            (PathBuf::from("/b/.git/refs"), "b".to_string(), false),
            (PathBuf::from("/a"), "a".to_string(), true),
        ];
        let ids = projects_for(
            &routes,
            [PathBuf::from("/a/.git/index"), PathBuf::from("/b/.git/refs/heads/main"), PathBuf::from("/a/.git/index.lock")],
        );
        assert_eq!(ids, vec!["a", "b"]);
        assert!(projects_for(&routes, [PathBuf::from("/a/.git/HEAD.lock")]).is_empty());
        assert!(projects_for(&routes, [PathBuf::from("/c/.git/HEAD")]).is_empty());
        assert!(projects_for(&routes, [PathBuf::from("/a/src/main.rs")]).is_empty(), "working files are not git changes");
    }

    #[test]
    fn working_tree_changes_skip_git_and_build_folders() {
        let routes = vec![(PathBuf::from("/a/.git"), "a".to_string(), false), (PathBuf::from("/a"), "a".to_string(), true)];
        let f = files_for(
            &routes,
            &[
                PathBuf::from("/a/src/main.ts"),
                PathBuf::from("/a/src/main.ts"),
                PathBuf::from("/a/.git/index"),
                PathBuf::from("/a/node_modules/x/index.js"),
                PathBuf::from("/a/README.md"),
                PathBuf::from("/b/other.ts"),
            ],
        );
        assert_eq!(f.get("a").unwrap(), &vec!["src/main.ts".to_string(), "README.md".to_string()]);
        assert_eq!(f.len(), 1);
    }
}
