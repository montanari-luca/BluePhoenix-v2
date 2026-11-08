//! The `bluephoenix` command line. The app's own executable doubles as the CLI: when it is started
//! as `<exe> --cli ...` (macOS/Linux shim) or as the console copy installed by `cli_install`
//! (Windows) it runs a command and exits without ever creating a window.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use crate::ai;
use crate::cli_install;
use crate::db::{self, Db};
use crate::detect;
use crate::error::{err, AppError, Result};
use crate::files;
use crate::project_file::{self, ProjectFile, ProjectFileCommand};

/// Must match `identifier` in tauri.conf.json (checked by a test); it names the app data folder.
const IDENTIFIER: &str = "com.astrodev.bluephoenix";

const COMMIT_SYSTEM: &str = "You write concise git commit messages in the Conventional Commits style. Reply with ONLY the commit message: a subject line of at most 72 characters, then optionally a blank line and a short bullet list body. No code fences, no quotes.";
const MAX_DIFF_CHARS: usize = 24_000;
const MAX_STARTER_COMMANDS: usize = 12;
/// Machine-generated files that would only eat the model's context.
const LOCKFILES: &[&str] = &[
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "composer.lock",
    "poetry.lock", "Gemfile.lock", "go.sum", "Pipfile.lock",
];

const HELP: &str = "BluePhoenix command line

Usage: bluephoenix <command> [options]

Commands:
  commit [-push]   Stage everything (git add .), write the commit message with the AI model
                   chosen in BluePhoenix settings, commit, and optionally push
  add [path]       Add the current directory (or path) to BluePhoenix as a project

Options:
  -h, --help       Show this help
  -V, --version    Show the version
";

const COMMIT_HELP: &str = "Usage: bluephoenix commit [-push]

Runs `git add .`, asks the AI model from BluePhoenix settings for a commit message based on the
staged changes, runs `git commit`, and with -push also `git push`.

Options:
  -push, --push, -p   Push after committing
  -h, --help          Show this help
";

const ADD_HELP: &str = "Usage: bluephoenix add [path]

Adds the current directory (or the given path) to BluePhoenix as a project: detects its type,
description, GitHub remote and build commands, and indexes its files, like adding it in the app.

Options:
  -h, --help          Show this help
";

/// Returns the exit code if this process was started as the CLI, or `None` to start the app.
pub fn dispatch() -> Option<i32> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let explicit = args.first().is_some_and(|a| a == "--cli");
    if explicit {
        args.remove(0);
    } else if !cli_install::running_as_cli_copy() {
        return None;
    }
    Some(run(&args))
}

fn run(args: &[String]) -> i32 {
    let rest = args.get(1..).unwrap_or(&[]);
    match args.first().map(String::as_str) {
        None | Some("help" | "-h" | "--help") => {
            print!("{HELP}");
            0
        }
        Some("-V" | "--version" | "version") => {
            println!("bluephoenix {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("commit") => match parse_commit_args(rest) {
            Ok(Some(push)) => finish(block_on(commit(push))),
            Ok(None) => {
                print!("{COMMIT_HELP}");
                0
            }
            Err(msg) => usage_error(&msg),
        },
        Some("add") => {
            if rest.iter().any(|a| a == "-h" || a == "--help") {
                print!("{ADD_HELP}");
                return 0;
            }
            if rest.len() > 1 {
                return usage_error("add takes at most one path");
            }
            finish(block_on(add(rest.first().map(String::as_str))))
        }
        Some(other) => usage_error(&format!("unknown command '{other}'")),
    }
}

fn usage_error(msg: &str) -> i32 {
    eprintln!("bluephoenix: {msg}\nRun `bluephoenix --help` for usage.");
    2
}

fn finish(r: Result<()>) -> i32 {
    match r {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("bluephoenix: {e}");
            1
        }
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime").block_on(f)
}

/// `Ok(Some(push))`, `Ok(None)` for --help, or a usage error message.
fn parse_commit_args(args: &[String]) -> std::result::Result<Option<bool>, String> {
    let mut push = false;
    for a in args {
        match a.as_str() {
            "-push" | "--push" | "-p" => push = true,
            "-h" | "--help" => return Ok(None),
            other => return Err(format!("unknown option '{other}' for commit")),
        }
    }
    Ok(Some(push))
}

// ---------- shared helpers ----------

fn open_db() -> Result<Db> {
    let path = dirs::data_dir().map(|d| d.join(IDENTIFIER).join("bluephoenix.db"));
    match path {
        Some(p) if p.is_file() => Db::open(&p),
        _ => err("BluePhoenix has not been set up yet. Open the app once, then try again."),
    }
}

/// Plain path string; drops the `\\?\` prefix Windows adds when canonicalising.
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    }
}

fn git_cmd(dir: &Path) -> Command {
    let mut c = Command::new("git");
    c.arg("-C").arg(dir).args(["-c", "core.quotepath=off"]);
    c
}

fn spawn_error(e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::Msg("git was not found. Install Git and make sure it is on your PATH.".into())
    } else {
        e.into()
    }
}

/// Runs git and captures its output; fails with git's own message.
fn git_capture(dir: &Path, args: &[&str]) -> Result<Output> {
    let out = git_cmd(dir).args(args).stdin(Stdio::null()).output().map_err(spawn_error)?;
    if out.status.success() {
        Ok(out)
    } else {
        let text = String::from_utf8_lossy(&out.stderr);
        let text = if text.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { text };
        err(text.trim().to_string())
    }
}

fn git_text(dir: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&git_capture(dir, args)?.stdout).to_string())
}

/// Runs git with the terminal attached so hooks, credential prompts and progress show normally.
fn git_live(dir: &Path, args: &[&str]) -> Result<bool> {
    Ok(git_cmd(dir).args(args).status().map_err(spawn_error)?.success())
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}\n… (truncated)")
}

/// Removes reasoning blocks and code fences some models wrap around the message.
fn clean_message(raw: &str) -> String {
    let re = regex::Regex::new(r"(?s)<think>.*?</think>").expect("valid regex");
    let mut s = re.replace_all(raw, "").trim().to_string();
    if let Some(rest) = s.strip_prefix("```") {
        s = rest.split_once('\n').map(|(_, body)| body).unwrap_or("").to_string();
    }
    if let Some(body) = s.trim_end().strip_suffix("```") {
        s = body.to_string();
    }
    s.trim().to_string()
}

// ---------- bluephoenix commit ----------

async fn commit(push: bool) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let root = PathBuf::from(
        git_text(&cwd, &["rev-parse", "--show-toplevel"])
            .map_err(|e| match e {
                AppError::Msg(m) if m.contains("not a git repository") => AppError::Msg("This folder is not a git repository.".into()),
                other => other,
            })?
            .trim(),
    );

    // Fail before touching the index when the AI model is not set up.
    let db = open_db()?;
    let model = ai::active_model(&db)?;

    if !git_live(&root, &["add", "."])? {
        return err("git add failed");
    }
    let nothing_staged = git_cmd(&root).args(["diff", "--cached", "--quiet"]).status().map_err(spawn_error)?.success();
    if nothing_staged {
        println!("Nothing to commit, working tree clean.");
    } else {
        let message = generate_message(&db, &root, &model).await?;
        println!("\n{}\n", indent(&message));
        if !git_live(&root, &["commit", "-m", &message])? {
            return err("git commit failed");
        }
    }

    if push {
        let has_upstream = git_cmd(&root)
            .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(spawn_error)?
            .success();
        let pushed = if has_upstream { git_live(&root, &["push"])? } else { git_live(&root, &["push", "-u", "origin", "HEAD"])? };
        if !pushed {
            return err("git push failed");
        }
    }
    Ok(())
}

async fn generate_message(db: &Db, root: &Path, model: &str) -> Result<String> {
    let stat = git_text(root, &["diff", "--cached", "--no-color", "--stat=120"])?;
    let mut diff_args = vec!["diff", "--cached", "--no-color", "--", "."];
    let excludes: Vec<String> = LOCKFILES.iter().map(|f| format!(":(exclude,glob)**/{f}")).collect();
    diff_args.extend(excludes.iter().map(String::as_str));
    let diff = git_text(root, &diff_args)?;
    let prompt = if diff.trim().is_empty() {
        format!("Write a commit message for these changes:\n\n{}", clip(&stat, MAX_DIFF_CHARS))
    } else {
        format!(
            "Write a commit message for this diff (lockfiles omitted):\n\nChanged files:\n{}\n\n{}",
            clip(&stat, 4000),
            clip(&diff, MAX_DIFF_CHARS)
        )
    };

    if let Some(status) = ai::ensure_local_server(db, false).await {
        match status.state.as_str() {
            "started" => eprintln!("{}", status.message),
            "failed" => eprintln!("warning: {}", status.message),
            _ => {}
        }
    }
    eprintln!("Writing the commit message with {model}…");
    let raw = ai::complete(db, COMMIT_SYSTEM, &prompt, Some(600), false)
        .await
        .map_err(|e| AppError::Msg(format!("{e}\nYour changes are staged; nothing was committed.")))?;
    let message = clean_message(&raw);
    if message.is_empty() {
        return err("The model returned an empty commit message. Your changes are staged; nothing was committed.");
    }
    Ok(message)
}

fn indent(s: &str) -> String {
    s.lines().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n")
}

// ---------- bluephoenix add ----------

async fn add(path_arg: Option<&str>) -> Result<()> {
    let dir = match path_arg {
        Some(p) => PathBuf::from(p),
        None => std::env::current_dir()?,
    };
    if !dir.is_dir() {
        return err(format!("'{}' is not a folder", dir.display()));
    }
    let dir = std::fs::canonicalize(&dir)?;
    let path = display_path(&dir);
    let db = open_db()?;

    let known = |p: &str| std::fs::canonicalize(p).map(|c| display_path(&c)).unwrap_or_else(|_| p.to_string());
    if let Some(existing) = db::list_projects(&db)?.into_iter().find(|s| known(&s.project.path) == path) {
        println!("{path} is already a project ({}).", existing.project.name);
        return Ok(());
    }

    let d = detect::detect_path(&path).await?;
    let restored = project_file::read(&dir);
    let now = db::now();
    let saved = db::save_project(
        &db,
        db::Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: match &restored {
                Some(f) => f.name.trim().to_string(),
                None if d.name.trim().is_empty() => "Project".into(),
                None => d.name.clone(),
            },
            description: match &restored {
                Some(f) => f.description.clone(),
                None => d.description.clone(),
            }
            .filter(|s| !s.trim().is_empty()),
            path: path.clone(),
            kind: restored.as_ref().and_then(|f| f.kind.clone()).filter(|k| !k.trim().is_empty()).unwrap_or_else(|| d.kind.clone()),
            favorite: false,
            github_url: match &restored {
                Some(f) => f.github_url.clone(),
                None => d.github_url.clone(),
            },
            website_url: restored.as_ref().and_then(|f| f.website_url.clone()),
            default_editor: restored.as_ref().and_then(|f| f.default_editor.clone()),
            default_terminal: restored.as_ref().and_then(|f| f.default_terminal.clone()),
            default_command_id: None,
            last_opened: None,
            created_at: now,
            updated_at: now,
            archived_at: None,
        },
    )?;
    let commands: Vec<ProjectFileCommand> = match &restored {
        Some(f) => f.commands.clone(),
        None => d
            .commands
            .iter()
            .take(MAX_STARTER_COMMANDS)
            .map(|c| ProjectFileCommand { label: c.label.clone(), command: c.command.clone(), cwd: None, source: Some(c.source.clone()) })
            .collect(),
    };
    for (i, c) in commands.iter().enumerate() {
        db::save_command(
            &db,
            &db::Command {
                id: uuid::Uuid::new_v4().to_string(),
                project_id: saved.id.clone(),
                label: c.label.clone(),
                command: c.command.clone(),
                cwd: c.cwd.clone(),
                source: c.source.clone().unwrap_or_else(|| "auto".into()),
                sort: i as i64,
            },
        )?;
    }
    let command_count = commands.len();
    let wrote_file = restored.is_none()
        && project_file::write(
            &dir,
            &ProjectFile {
                name: saved.name.clone(),
                description: saved.description.clone(),
                kind: Some(saved.kind.clone()),
                github_url: saved.github_url.clone(),
                website_url: saved.website_url.clone(),
                default_editor: saved.default_editor.clone(),
                default_terminal: saved.default_terminal.clone(),
                commands,
            },
        )
        .map_err(|e| eprintln!("warning: could not write {}: {e}", project_file::FILE_NAME))
        .is_ok();
    let (entries, truncated) = files::scan_files(&dir);
    files::store_files(&db, &saved.id, &entries)?;

    println!("Added {} ({})", saved.name, saved.kind);
    println!("  Folder:    {path}");
    if let Some(url) = &saved.github_url {
        println!("  GitHub:    {url}");
    }
    println!("  Commands:  {command_count} {}", if restored.is_some() { "restored" } else { "detected" });
    println!("  Files:     {} indexed{}", entries.len(), if truncated { " (list truncated)" } else { "" });
    if restored.is_some() {
        println!("  Settings:  restored from {}", project_file::FILE_NAME);
    } else if wrote_file {
        println!("  Settings:  saved to {}", project_file::FILE_NAME);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn identifier_matches_tauri_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[test]
    fn parses_commit_flags() {
        assert_eq!(parse_commit_args(&s(&[])), Ok(Some(false)));
        assert_eq!(parse_commit_args(&s(&["-push"])), Ok(Some(true)));
        assert_eq!(parse_commit_args(&s(&["--push"])), Ok(Some(true)));
        assert_eq!(parse_commit_args(&s(&["-p"])), Ok(Some(true)));
        assert_eq!(parse_commit_args(&s(&["--help"])), Ok(None));
        assert!(parse_commit_args(&s(&["--nope"])).is_err());
    }

    #[test]
    fn cleans_model_output() {
        assert_eq!(clean_message("```\nfeat: add cli\n```"), "feat: add cli");
        assert_eq!(clean_message("```text\nfix: a\n\n- b\n```\n"), "fix: a\n\n- b");
        assert_eq!(clean_message("<think>hmm\nthinking</think>\n\nchore: x\n"), "chore: x");
        assert_eq!(clean_message("  docs: y  "), "docs: y");
        assert_eq!(clean_message("```\n```"), "");
    }

    #[test]
    fn strips_windows_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\dev\app")), r"C:\dev\app");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\share\app")), r"\\srv\share\app");
        assert_eq!(display_path(Path::new("/tmp/app")), "/tmp/app");
    }

    #[test]
    fn clips_long_text_on_char_boundaries() {
        assert_eq!(clip("abc", 10), "abc");
        assert!(clip(&"é".repeat(50), 10).starts_with(&"é".repeat(10)));
    }
}
