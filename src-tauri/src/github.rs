//! Pull requests and CI status from GitHub, through the GitHub CLI (`gh`) the user already has
//! signed in. Nothing here needs a token in BluePhoenix. Results are cached for a few minutes and
//! refreshed in the background. Without `gh`, or without a GitHub remote, everything quietly
//! reports "unavailable" with a reason the UI can show once.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::process::Command;

use crate::db::{active_projects, list_projects, Db};
use crate::error::{err, LockExt, Result};
use crate::git::git_status;
use crate::scheduler::Job;

const TTL: Duration = Duration::from_secs(5 * 60);
const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: i64,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub is_draft: bool,
    /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "" (none)
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub head_ref_name: String,
    #[serde(default)]
    pub author: Option<Author>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Author {
    pub login: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CiRun {
    /// queued | in_progress | completed …
    pub status: String,
    /// success | failure | cancelled | skipped … (empty while running)
    #[serde(default)]
    pub conclusion: String,
    #[serde(default)]
    pub workflow_name: String,
    pub url: String,
    #[serde(default)]
    pub head_branch: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub project_id: String,
    pub available: bool,
    /// Why it is unavailable: no-gh | no-remote | signed-out | error
    pub reason: Option<String>,
    pub message: Option<String>,
    pub pulls: Vec<PullRequest>,
    /// Open PRs where your review is requested.
    pub review_requested: Vec<i64>,
    /// Latest workflow run on the current branch.
    pub ci: Option<CiRun>,
    pub checked_at: i64,
}

#[derive(Default)]
pub struct GithubCache(Mutex<HashMap<String, (Instant, GithubStatus)>>);

fn gh_path() -> Option<&'static std::path::PathBuf> {
    static GH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    GH.get_or_init(|| which::which("gh").ok()).as_ref()
}

pub fn is_github(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.contains("github.com:") || u.contains("github.com/")
}

async fn gh(dir: &str, args: &[&str]) -> std::result::Result<String, String> {
    let Some(bin) = gh_path() else { return Err("no-gh".into()) };
    let mut cmd = Command::new(bin);
    cmd.current_dir(dir)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = tokio::time::timeout(TIMEOUT, cmd.output()).await.map_err(|_| "gh timed out".to_string())?.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Maps a `gh` failure to a reason the UI understands.
pub fn classify(stderr: &str) -> (&'static str, String) {
    let s = stderr.to_ascii_lowercase();
    if stderr == "no-gh" {
        ("no-gh", "Install the GitHub CLI (gh) to see pull requests and CI here.".into())
    } else if s.contains("gh auth login") || s.contains("not logged") || s.contains("authentication") {
        ("signed-out", "Run `gh auth login` in a terminal to see pull requests and CI.".into())
    } else if s.contains("no git remotes") || s.contains("none of the git remotes") || s.contains("could not resolve to a repository") {
        ("no-remote", "This repository is not on GitHub.".into())
    } else {
        ("error", stderr.lines().next().unwrap_or("gh failed").to_string())
    }
}

pub fn parse_pulls(json: &str) -> Vec<PullRequest> {
    serde_json::from_str(json).unwrap_or_default()
}

pub fn parse_numbers(json: &str) -> Vec<i64> {
    #[derive(Deserialize)]
    struct N {
        number: i64,
    }
    serde_json::from_str::<Vec<N>>(json).unwrap_or_default().into_iter().map(|n| n.number).collect()
}

pub fn parse_runs(json: &str) -> Option<CiRun> {
    serde_json::from_str::<Vec<CiRun>>(json).ok()?.into_iter().next()
}

async fn fetch(project_id: &str, path: &str) -> GithubStatus {
    let mut s = GithubStatus { project_id: project_id.to_string(), checked_at: crate::db::now(), ..Default::default() };
    let unavailable = |mut s: GithubStatus, e: &str| {
        let (reason, msg) = classify(e);
        s.reason = Some(reason.into());
        s.message = Some(msg);
        s
    };
    if gh_path().is_none() {
        return unavailable(s, "no-gh");
    }
    let Ok(st) = git_status(path.to_string()).await else { return unavailable(s, "none of the git remotes") };
    if !st.remote_url.as_deref().is_some_and(is_github) {
        return unavailable(s, "none of the git remotes");
    }
    let fields = "number,title,url,isDraft,reviewDecision,headRefName,author,updatedAt";
    let pull_args = ["pr", "list", "--state", "open", "--limit", "30", "--json", fields];
    let review_args = ["pr", "list", "--state", "open", "--search", "review-requested:@me", "--limit", "50", "--json", "number"];
    let pulls = gh(path, &pull_args);
    let review = gh(path, &review_args);
    let branch = st.branch.clone().unwrap_or_default();
    let run_fields = "status,conclusion,workflowName,url,headBranch";
    let mut run_args = vec!["run", "list", "--limit", "1", "--json", run_fields];
    if !branch.is_empty() {
        run_args.extend(["--branch", branch.as_str()]);
    }
    let runs = gh(path, &run_args);
    let (pulls, review, runs) = tokio::join!(pulls, review, runs);
    match pulls {
        Ok(j) => s.pulls = parse_pulls(&j),
        Err(e) => return unavailable(s, &e),
    }
    s.review_requested = review.map(|j| parse_numbers(&j)).unwrap_or_default();
    s.ci = runs.ok().and_then(|j| parse_runs(&j));
    s.available = true;
    s
}

fn cached(cache: &GithubCache, id: &str) -> Option<GithubStatus> {
    cache.0.lock_ok().get(id).filter(|(at, _)| at.elapsed() < TTL).map(|(_, s)| s.clone())
}

fn put(cache: &GithubCache, s: &GithubStatus) {
    cache.0.lock_ok().insert(s.project_id.clone(), (Instant::now(), s.clone()));
}

/// PRs and CI for one project, from the cache unless `refresh`.
#[tauri::command]
pub async fn github_status(db: State<'_, Db>, cache: State<'_, GithubCache>, project_id: String, refresh: bool) -> Result<GithubStatus> {
    if let Some(s) = cached(&cache, &project_id).filter(|_| !refresh) {
        return Ok(s);
    }
    let Some(p) = list_projects(&db)?.into_iter().find(|p| p.project.id == project_id) else { return err("Project not found") };
    let s = fetch(&project_id, &p.project.path).await;
    put(&cache, &s);
    Ok(s)
}

/// Everything in the cache, for the dashboard badges.
#[tauri::command]
pub async fn github_cached(cache: State<'_, GithubCache>) -> Result<Vec<GithubStatus>> {
    Ok(cache.0.lock_ok().values().map(|(_, s)| s.clone()).collect())
}

pub fn jobs() -> Vec<Job> {
    vec![Job::every("github", Duration::from_secs(25), TTL, |app| async move {
        if gh_path().is_none() {
            return;
        }
        let projects = active_projects(&app.state::<Db>()).unwrap_or_default();
        let mut fresh = vec![];
        for p in projects.into_iter().filter(|p| !p.project.path.is_empty()) {
            // Only repositories on GitHub; skip the rest without calling gh.
            let remote = git_status(p.project.path.clone()).await.ok().and_then(|s| s.remote_url);
            if !remote.as_deref().is_some_and(is_github) {
                continue;
            }
            let s = fetch(&p.project.id, &p.project.path).await;
            put(&app.state::<GithubCache>(), &s);
            fresh.push(s);
        }
        if !fresh.is_empty() {
            let _ = app.emit("github-status", fresh);
        }
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_github_remotes() {
        assert!(is_github("git@github.com:o/r.git"));
        assert!(is_github("https://github.com/o/r"));
        assert!(!is_github("https://gitlab.com/o/r"));
    }

    #[test]
    fn parses_gh_json() {
        let pulls = parse_pulls(
            r#"[{"number":12,"title":"Add graph","url":"https://github.com/o/r/pull/12","isDraft":false,
                "reviewDecision":"APPROVED","headRefName":"graph","author":{"login":"ann","name":"Ann"},
                "updatedAt":"2026-11-01T10:00:00Z"},
               {"number":13,"title":"WIP","url":"u","isDraft":true,"reviewDecision":"","headRefName":"wip","author":{"login":"bob"},"updatedAt":""}]"#,
        );
        assert_eq!(pulls.len(), 2);
        assert_eq!(pulls[0].review_decision.as_deref(), Some("APPROVED"));
        assert_eq!(pulls[0].author.as_ref().unwrap().login, "ann");
        assert!(pulls[1].is_draft);
        assert_eq!(parse_numbers(r#"[{"number":4},{"number":9}]"#), vec![4, 9]);
        let run = parse_runs(r#"[{"status":"completed","conclusion":"failure","workflowName":"CI","url":"u","headBranch":"main"}]"#).unwrap();
        assert_eq!((run.status.as_str(), run.conclusion.as_str()), ("completed", "failure"));
        assert!(parse_runs("[]").is_none());
        assert!(parse_pulls("not json").is_empty());
    }

    #[test]
    fn classifies_failures() {
        assert_eq!(classify("no-gh").0, "no-gh");
        assert_eq!(classify("To get started with GitHub CLI, please run:  gh auth login").0, "signed-out");
        assert_eq!(classify("none of the git remotes configured for this repository point to a known GitHub host").0, "no-remote");
        assert_eq!(classify("HTTP 502").0, "error");
    }
}
