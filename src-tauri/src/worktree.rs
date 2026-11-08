//! Git worktrees: several checkouts of one repository, each on its own branch, in its own folder.

use std::path::Path;

use serde::Serialize;

use crate::error::{err, Result};
use crate::git::exec;

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    /// Short branch name; `None` when detached or bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    /// Its folder is gone; `git worktree prune` would remove it.
    pub prunable: bool,
    /// The repository's main working tree (listed first by git).
    pub main: bool,
}

/// Parses `git worktree list --porcelain`.
pub fn parse(text: &str) -> Vec<Worktree> {
    let mut out = vec![];
    for block in text.split("\n\n").map(str::trim).filter(|b| !b.is_empty()) {
        let mut w = Worktree::default();
        for line in block.lines() {
            let (key, val) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => w.path = val.to_string(),
                "HEAD" => w.head = Some(val.to_string()),
                "branch" => w.branch = Some(val.strip_prefix("refs/heads/").unwrap_or(val).to_string()),
                "detached" => w.detached = true,
                "bare" => w.bare = true,
                "locked" => w.locked = true,
                "prunable" => w.prunable = true,
                _ => {}
            }
        }
        if !w.path.is_empty() {
            w.main = out.is_empty();
            out.push(w);
        }
    }
    out
}

fn check_name(name: &str, what: &str) -> Result<()> {
    if name.trim().is_empty() || name.starts_with('-') || name.contains(char::is_whitespace) || name.contains("..") {
        return err(format!("That is not a valid {what}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_worktrees(path: String) -> Result<Vec<Worktree>> {
    let o = exec(&path, &["worktree", "list", "--porcelain"], 15).await?;
    if !o.ok {
        return err(o.stderr.trim().to_string());
    }
    Ok(parse(&o.stdout))
}

/// Creates a worktree in `dir` for `branch`. With `create`, the branch is new (started from the
/// current commit); otherwise it must exist (a local branch, or a remote one git can track).
#[tauri::command]
pub async fn git_worktree_add(path: String, dir: String, branch: String, create: bool) -> Result<String> {
    check_name(&branch, "branch name")?;
    if !Path::new(&dir).is_absolute() {
        return err("Choose a full folder path for the worktree");
    }
    if Path::new(&dir).exists() && std::fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return err("That folder already exists and is not empty");
    }
    let args: Vec<&str> = if create {
        vec!["worktree", "add", "-b", &branch, "--", &dir]
    } else {
        vec!["worktree", "add", "--", &dir, &branch]
    };
    let o = exec(&path, &args, 120).await?;
    if !o.ok {
        return err(o.stderr.trim().to_string());
    }
    Ok(dir)
}

/// Removes a linked worktree (never the main one). Without `force`, git refuses when it has changes.
#[tauri::command]
pub async fn git_worktree_remove(path: String, dir: String, force: bool) -> Result<()> {
    let list = git_worktrees(path.clone()).await?;
    match list.iter().find(|w| w.path == dir) {
        None => return err("That worktree no longer exists"),
        Some(w) if w.main => return err("The main working tree cannot be removed"),
        _ => {}
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--", dir.as_str()]);
    let o = exec(&path, &args, 60).await?;
    if !o.ok {
        let msg = o.stderr.trim();
        if msg.contains("contains modified or untracked files") {
            return err("This worktree has uncommitted changes. Remove it anyway to discard them.");
        }
        return err(msg.to_string());
    }
    let _ = exec(&path, &["worktree", "prune"], 15).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_output() {
        let text = "worktree /repo\nHEAD 1111\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD 2222\nbranch refs/heads/feature/x\nlocked\n\nworktree /tmp/gone\nHEAD 3333\ndetached\nprunable gitdir file points to non-existent location\n";
        let w = parse(text);
        assert_eq!(w.len(), 3);
        assert!(w[0].main && w[0].branch.as_deref() == Some("main"));
        assert_eq!(w[1].branch.as_deref(), Some("feature/x"));
        assert!(w[1].locked && !w[1].main);
        assert!(w[2].detached && w[2].prunable && w[2].branch.is_none());
    }

    #[tokio::test]
    async fn add_list_and_remove_in_a_real_repo() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("bp-wt-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a"), "1").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "one"]);

        let p = repo.to_string_lossy().to_string();
        let dir = root.join("repo-feature").to_string_lossy().to_string();
        assert!(git_worktree_add(p.clone(), "relative".into(), "x".into(), true).await.is_err());
        assert!(git_worktree_add(p.clone(), dir.clone(), "--evil".into(), true).await.is_err());
        git_worktree_add(p.clone(), dir.clone(), "feature".into(), true).await.unwrap();

        let list = git_worktrees(p.clone()).await.unwrap();
        assert_eq!(list.len(), 2);
        let added = list.iter().find(|w| !w.main).unwrap();
        assert_eq!(added.branch.as_deref(), Some("feature"));

        assert!(git_worktree_remove(p.clone(), list[0].path.clone(), false).await.is_err(), "main is protected");
        std::fs::write(Path::new(&added.path).join("dirty"), "x").unwrap();
        assert!(git_worktree_remove(p.clone(), added.path.clone(), false).await.is_err(), "refuses with changes");
        git_worktree_remove(p.clone(), added.path.clone(), true).await.unwrap();
        assert_eq!(git_worktrees(p).await.unwrap().len(), 1);
    }
}
