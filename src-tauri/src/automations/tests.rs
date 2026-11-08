use super::*;

pub(super) fn auto(trigger: &str) -> Automation {
    Automation {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Test".into(),
        description: String::new(),
        enabled: true,
        trigger: trigger.into(),
        run_at: None,
        repeat_hours: None,
        notify: "none".into(),
        notify_before_min: None,
        target_mode: "all".into(),
        project_ids: vec![],
        kind_filter: None,
        idle_hours: None,
        require_clean_git: false,
        require_git_repo: false,
        commands: "true".into(),
        sort: 0,
        last_run: None,
        last_status: None,
    }
}

pub(super) fn temp_db() -> Db {
    Db::open(&std::env::temp_dir().join(format!("bp-auto-{}.db", uuid::Uuid::new_v4()))).unwrap()
}

pub(super) fn temp_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("bp-auto-dir-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

pub(super) fn project(db: &Db, name: &str, kind: &str, dir: &Path) -> Project {
    let t = now();
    crate::db::save_project(
        db,
        Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            description: None,
            path: dir.to_string_lossy().to_string(),
            kind: kind.into(),
            favorite: false,
            github_url: None,
            website_url: None,
            default_editor: None,
            default_terminal: None,
            default_command_id: None,
            last_opened: None,
            created_at: t,
            updated_at: t,
            archived_at: None,
        },
    )
    .unwrap()
}

pub(super) fn age(file: &Path, hours: u64) {
    let f = std::fs::OpenOptions::new().write(true).open(file).unwrap();
    f.set_modified(std::time::SystemTime::now() - Duration::from_secs(hours * 3600)).unwrap();
}

#[test]
pub(super) fn manual_is_never_auto_due() {
    assert!(!is_due(&auto("manual"), None, now()));
}

#[test]
pub(super) fn no_repeat_no_date_always_runs() {
    let a = auto("launch");
    assert!(is_due(&a, None, now()));
    assert!(is_due(&a, Some(now()), now()));
}

#[test]
pub(super) fn repeat_waits_for_the_interval() {
    let mut a = auto("launch");
    a.repeat_hours = Some(48);
    let t = 1_000_000_000_000;
    assert!(is_due(&a, None, t));
    assert!(!is_due(&a, Some(t), t + 47 * HOUR_MS));
    assert!(is_due(&a, Some(t), t + 48 * HOUR_MS));
}

#[test]
pub(super) fn future_date_blocks_until_reached() {
    let mut a = auto("launch");
    a.repeat_hours = Some(24);
    a.run_at = Some(5_000);
    assert!(!is_due(&a, None, 4_999));
    assert!(is_due(&a, None, 5_000));
    // The interval is measured from the last run but never before the start date.
    assert_eq!(next_due(&a, Some(0)), Some(24 * HOUR_MS));
}

#[test]
pub(super) fn one_off_runs_once() {
    let mut a = auto("schedule");
    a.run_at = Some(5_000);
    assert!(is_due(&a, None, 6_000));
    assert!(!is_due(&a, Some(6_000), 7_000));
    // Moving the date forward re-arms it.
    a.run_at = Some(9_000);
    assert!(is_due(&a, Some(6_000), 9_000));
}

#[test]
pub(super) fn validation_rejects_impossible_setups() {
    let mut a = auto("schedule");
    assert!(validate(&mut a).is_err(), "schedule without date or repeat");
    a.repeat_hours = Some(1);
    assert!(validate(&mut a).is_ok());

    let mut b = auto("launch");
    b.notify = "before".into();
    b.notify_before_min = Some(5);
    assert!(validate(&mut b).is_err(), "before only for schedule");

    let mut c = auto("launch");
    c.target_mode = "selected".into();
    assert!(validate(&mut c).is_err(), "selected needs projects");

    let mut d = auto("launch");
    d.commands = "  ".into();
    assert!(validate(&mut d).is_err());
    let mut e = auto("launch");
    e.name = " ".into();
    assert!(validate(&mut e).is_err());
}

#[test]
pub(super) fn targets_follow_selection_kind_and_folder() {
    let db = temp_db();
    let (d1, d2) = (temp_dir(), temp_dir());
    let tauri = project(&db, "A", "Tauri", &d1);
    let node = project(&db, "B", "Node.js", &d2);
    project(&db, "Gone", "Tauri", &std::env::temp_dir().join("bp-does-not-exist"));

    let mut all = auto("launch");
    assert_eq!(resolve_targets(&db, &all).unwrap().len(), 2, "missing folder is skipped");
    all.kind_filter = Some("tauri".into());
    let t = resolve_targets(&db, &all).unwrap();
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].id, tauri.id);

    let mut sel = auto("launch");
    sel.target_mode = "selected".into();
    sel.project_ids = vec![node.id.clone()];
    let t = resolve_targets(&db, &sel).unwrap();
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].id, node.id);
}

#[test]
pub(super) fn edited_within_ignores_old_files_and_node_modules() {
    let dir = temp_dir();
    let old = dir.join("old.txt");
    std::fs::write(&old, "x").unwrap();
    age(&old, 100);
    std::fs::create_dir_all(dir.join("node_modules")).unwrap();
    std::fs::write(dir.join("node_modules/new.js"), "x").unwrap();
    assert!(!edited_within(&dir, Duration::from_secs(48 * 3600)));
    std::fs::write(dir.join("fresh.txt"), "x").unwrap();
    assert!(edited_within(&dir, Duration::from_secs(48 * 3600)));
}

#[cfg(unix)]
#[tokio::test]
pub(super) async fn shell_reports_status_exit_code_and_output() {
    let dir = temp_dir();
    let d = dir.to_string_lossy().to_string();
    let ok = run_shell(&d, "echo hi", Duration::from_secs(10)).await;
    assert_eq!((ok.status.as_str(), ok.exit_code), ("ok", Some(0)));
    assert!(ok.output.contains("hi"));
    let bad = run_shell(&d, "echo boom >&2; exit 3", Duration::from_secs(10)).await;
    assert_eq!((bad.status.as_str(), bad.exit_code), ("failed", Some(3)));
    assert!(bad.output.contains("boom"));
    let slow = run_shell(&d, "sleep 5", Duration::from_millis(200)).await;
    assert_eq!(slow.status, "timeout");
}

#[cfg(unix)]
#[tokio::test]
pub(super) async fn run_records_state_and_respects_repeat_and_idle() {
    let db = temp_db();
    let dir = temp_dir();
    let stale = dir.join("a.txt");
    std::fs::write(&stale, "x").unwrap();
    age(&stale, 100);
    let p = project(&db, "P", "Other", &dir);

    let mut a = auto("launch");
    a.target_mode = "selected".into();
    a.project_ids = vec![p.id.clone()];
    a.repeat_hours = Some(48);
    a.idle_hours = Some(48);
    a.commands = "echo done > out.txt".into();
    let a = save_automation(&db, a).unwrap();

    let opts = RunOpts { only_due: true, project_id: None, deadline: None };
    let s = run_automation(&db, &a, &opts).await.unwrap();
    assert_eq!((s.ok, s.failed), (1, 0));
    assert!(dir.join("out.txt").exists());
    assert_eq!(list_runs(&db, &a.id).unwrap().len(), 1);

    // Inside the repeat window nothing runs, and nothing is reported as skipped.
    let s = run_automation(&db, &a, &opts).await.unwrap();
    assert_eq!((s.ran(), s.skipped.len()), (0, 0));

    // A manual run still honours the idle requisite: out.txt is fresh now.
    let manual = RunOpts { only_due: false, project_id: None, deadline: None };
    let s = run_automation(&db, &a, &manual).await.unwrap();
    assert_eq!(s.ran(), 0);
    assert_eq!(s.skipped.len(), 1);
    assert!(s.skipped[0].reason.contains("edited"));
    assert_eq!(get_automation(&db, &a.id).unwrap().last_status.as_deref(), Some("ok"));
}

#[cfg(unix)]
#[tokio::test]
pub(super) async fn clean_git_requisite_blocks_dirty_repos() {
    let db = temp_db();
    let dir = temp_dir();
    let g = |args: &[&str]| {
        assert!(std::process::Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap().status.success())
    };
    g(&["init", "-q"]);
    let p = project(&db, "Repo", "Other", &dir);
    let mut a = auto("manual");
    a.require_clean_git = true;
    a.commands = "true".into();
    let opts = RunOpts { only_due: false, project_id: Some(p.id.clone()), deadline: None };
    assert_eq!(run_automation(&db, &a, &opts).await.unwrap().ran(), 1, "empty repo is clean");
    std::fs::write(dir.join("new.txt"), "x").unwrap();
    let s = run_automation(&db, &a, &opts).await.unwrap();
    assert_eq!((s.ran(), s.skipped[0].reason.as_str()), (0, "uncommitted changes"));
}
