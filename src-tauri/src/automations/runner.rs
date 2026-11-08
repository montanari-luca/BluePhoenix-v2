//! Running an automation's shell script in each target project.

use super::*;

pub struct ShellResult {
    /// ok | failed | timeout
    pub status: String,
    pub exit_code: Option<i32>,
    pub output: String,
}

pub(super) fn shell_command(script: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        c.creation_flags(0x0800_0000);
        c
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(shell);
        c.args(["-lc", script]);
        c
    }
}

pub(super) fn tail(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// Runs `script` in the user's shell inside `dir`, capturing stdout + stderr.
pub async fn run_shell(dir: &str, script: &str, timeout: Duration) -> ShellResult {
    let mut cmd = shell_command(script);
    cmd.current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let failed = |msg: String| ShellResult { status: "failed".into(), exit_code: None, output: msg };
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return failed(format!("Could not start the shell: {e}")),
    };
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => ShellResult {
            status: "timeout".into(),
            exit_code: None,
            output: format!("Stopped after {} min without finishing.", (timeout.as_secs() / 60).max(1)),
        },
        Ok(Err(e)) => failed(e.to_string()),
        Ok(Ok(o)) => {
            let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            ShellResult {
                status: if o.status.success() { "ok" } else { "failed" }.into(),
                exit_code: o.status.code(),
                output: tail(&text, OUTPUT_TAIL),
            }
        }
    }
}

pub struct RunOpts {
    /// Only projects whose repeat/date is due (automatic triggers); manual runs pass false.
    pub only_due: bool,
    pub project_id: Option<String>,
    /// Hard stop for the whole batch (used on quit).
    pub deadline: Option<Instant>,
}

pub async fn run_automation(db: &Db, a: &Automation, opts: &RunOpts) -> Result<RunSummary> {
    let mut sum = RunSummary { automation_id: a.id.clone(), name: a.name.clone(), notify: a.notify.clone(), ok: 0, failed: 0, skipped: vec![] };
    for p in resolve_targets(db, a)? {
        if opts.project_id.as_deref().is_some_and(|id| id != p.id) {
            continue;
        }
        if opts.only_due && !is_due(a, last_run(db, &a.id, &p.id), now()) {
            continue;
        }
        let mut timeout = RUN_TIMEOUT;
        if let Some(d) = opts.deadline {
            let left = d.saturating_duration_since(Instant::now());
            if left.is_zero() {
                sum.skipped.push(Skipped { project: p.name.clone(), reason: "out of time".into() });
                continue;
            }
            timeout = timeout.min(left);
        }
        if let Some(reason) = unmet_requisite(a, &p).await {
            sum.skipped.push(Skipped { project: p.name.clone(), reason });
            continue;
        }
        let started = now();
        let res = run_shell(&p.path, &a.commands, timeout).await;
        record_run(db, a, &p, started, now(), &res)?;
        if res.status == "ok" {
            sum.ok += 1;
        } else {
            sum.failed += 1;
        }
    }
    Ok(sum)
}

/// Runs every enabled automation of `trigger` that is due; returns only those that ran something.
pub async fn run_trigger(db: &Db, trigger: &str, project_id: Option<&str>, deadline: Option<Instant>) -> Vec<RunSummary> {
    let opts = RunOpts { only_due: true, project_id: project_id.map(String::from), deadline };
    let mut out = vec![];
    for a in list_automations(db).unwrap_or_default() {
        if !a.enabled || a.trigger != trigger {
            continue;
        }
        if let Ok(s) = run_automation(db, &a, &opts).await {
            if s.ran() > 0 {
                out.push(s);
            }
        }
    }
    out
}

/// Whether any enabled automation of `trigger` has a project due (requisites not checked).
pub fn any_due(db: &Db, trigger: &str) -> bool {
    let t = now();
    list_automations(db).unwrap_or_default().iter().filter(|a| a.enabled && a.trigger == trigger).any(|a| {
        resolve_targets(db, a).unwrap_or_default().iter().any(|p| is_due(a, last_run(db, &a.id, &p.id), t))
    })
}

/// The soonest time any of the automation's projects becomes due.
pub fn soonest_due(db: &Db, a: &Automation) -> Option<i64> {
    resolve_targets(db, a)
        .unwrap_or_default()
        .iter()
        .filter_map(|p| next_due(a, last_run(db, &a.id, &p.id)))
        .min()
}
