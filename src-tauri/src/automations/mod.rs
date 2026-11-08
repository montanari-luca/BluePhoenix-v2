//! Automations: user-defined shell commands that run inside project folders on a trigger.
//! This module is the engine (storage, due logic, requisites, execution). It only needs a `&Db`,
//! so it works without Tauri; `automation_runtime.rs` wires it to app events and notifications.
//!
//! Layout: the model and Tauri commands live here; `storage`, `schedule`, `targets` and `runner`
//! hold the engine, and `tests.rs` covers all of it.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;

use crate::db::{active_projects, now, Db, Project};
use crate::error::{err, AppError, LockExt, Result};

const HOUR_MS: i64 = 3_600_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OUTPUT_TAIL: usize = 4000;
const RUNS_KEPT: i64 = 200;
const MAX_WALK: usize = 200_000;

const TRIGGERS: [&str; 9] = ["launch", "quit", "manual", "schedule", "commit", "files", "branch", "push", "fork"];
const NOTIFY: [&str; 3] = ["none", "on_run", "before"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub enabled: bool,
    /// launch | quit | manual | schedule | commit | files | branch | push | fork
    pub trigger: String,
    /// `files`: which changed paths count (globs, e.g. `src/**/*.ts`). `branch` / `push`: which
    /// branches (globs, e.g. `release/*`); empty means any.
    #[serde(default)]
    pub trigger_filter: Option<String>,
    /// First time it may run (epoch ms).
    pub run_at: Option<i64>,
    pub repeat_hours: Option<i64>,
    /// none | on_run | before (before is only valid for `schedule`)
    pub notify: String,
    pub notify_before_min: Option<i64>,
    /// selected | all
    pub target_mode: String,
    pub project_ids: Vec<String>,
    pub kind_filter: Option<String>,
    /// Requisite: the project was not edited for this many hours.
    pub idle_hours: Option<i64>,
    pub require_clean_git: bool,
    pub require_git_repo: bool,
    pub commands: String,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub last_run: Option<i64>,
    #[serde(default)]
    pub last_status: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub project_id: String,
    pub project_name: String,
    pub started_at: i64,
    pub finished_at: i64,
    /// ok | failed | timeout
    pub status: String,
    pub exit_code: Option<i32>,
    pub output: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub project: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub automation_id: String,
    pub name: String,
    pub notify: String,
    pub ok: u32,
    pub failed: u32,
    pub skipped: Vec<Skipped>,
}

impl RunSummary {
    pub fn ran(&self) -> u32 {
        self.ok + self.failed
    }
}

mod runner;
mod schedule;
mod storage;
mod targets;
mod triggers;
#[cfg(test)]
mod tests;

pub use runner::*;
pub use schedule::*;
pub use storage::*;
pub use targets::*;
pub use triggers::*;

// ---------- commands ----------

#[tauri::command]
pub async fn automations_list(db: State<'_, Db>) -> Result<Vec<Automation>> {
    list_automations(&db)
}

#[tauri::command]
pub async fn automation_save(db: State<'_, Db>, automation: Automation) -> Result<Automation> {
    save_automation(&db, automation)
}

#[tauri::command]
pub async fn automation_delete(db: State<'_, Db>, id: String) -> Result<()> {
    delete_automation(&db, &id)
}

#[tauri::command]
pub async fn automation_runs(db: State<'_, Db>, id: String) -> Result<Vec<AutomationRun>> {
    list_runs(&db, &id)
}
