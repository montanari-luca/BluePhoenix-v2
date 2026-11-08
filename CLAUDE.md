# BluePhoenix

A project manager for developers: a Tauri v2 desktop app (macOS, Windows, Linux) plus a SwiftUI iPhone app that share data through a user-owned PostgreSQL database. The user guide lives in `docs/`; `README.md` is the product overview.

## Layout

- `src/`: React 19 + TypeScript, built with Vite and styled with Tailwind v4. It uses Zustand for state and HashRouter for routing.
  - `pages/`: Dashboard, ProjectPage, Automations, Settings. The sections of the Settings page are in `pages/settings/`.
  - `tabs/`: the project page tabs (Overview, Git, To-dos, Time, Commands, Terminal, Files, Changelog).
  - `components/`: dialogs, cards, the command palette, and `ui.tsx` (Modal, Field, Toggle, Segmented, toasts, `useConfirm`). The New project wizard is `NewProjectDialog.tsx`, which holds state and actions, plus its step views in `components/new-project/`.
  - `lib/`:
    - `api.ts`: every Tauri `invoke`.
    - `store.ts`: the global Zustand store, the toasts, and the `logError` / `reportError` helpers.
    - `types.ts`: the shared types.
    - `initializer/`: the wizard templates, with `types`, `helpers` and `templates/<family>.ts`.
    - `automations.ts`, `fork.ts`, `ai.ts`, `terminals.ts`, `theme.ts`, `format.ts`.
- `src-tauri/src/`: the Rust backend.
  - `lib.rs` registers plugins, managed state, background tasks and every `#[tauri::command]` in `generate_handler!`.
  - `db.rs`: local SQLite (`Db(Mutex<Connection>)`) and its migrations.
  - `sync.rs`: Postgres sync (last-write-wins on `updated_at`, tombstones, server timestamps). The `bp_*` tables are generated from the synced-table list.
  - `git.rs` shells out to the system `git`; `fork_sync.rs` handles upstream checks for forks.
  - `automations/` is the engine (`storage`, `schedule`, `targets`, `runner`, `tests`). `automation_runtime.rs` wires it to app events.
  - `initializer.rs` runs wizard plans; `icons.rs` generates icons.
  - Also: `pty.rs`, `launch.rs` (editors and terminals), `detect.rs` (project type and commands), `files.rs`, `ai.rs`, `updater.rs`, `cli.rs` / `cli_install.rs` (the `bluephoenix` CLI) and `project_file.rs` (the `.bluephoenix` file).
  - `error.rs`: `AppError`, `Result`, `err()`, and `LockExt::lock_ok()`.
- `ios/`: the SwiftUI app, built with PostgresNIO. Generate the project with `xcodegen generate` (see `ios/README.md`). It implements the same sync rules as `sync.rs`.
- `scripts/`: dev, build, installer and version scripts.

## Adding a feature end to end

1. Write a Rust `#[tauri::command]` in the relevant module that returns `crate::error::Result<T>`. Structs use `#[serde(rename_all = "camelCase")]`.
2. Register it in `generate_handler!` in `src-tauri/src/lib.rs`.
3. Add the TS type to `src/lib/types.ts` and a wrapper to `api` in `src/lib/api.ts`.
4. Use it from a component, or from `store.ts` if it is global state.
5. For progress the backend pushes, emit an event with `app.emit("name", payload)` and `listen` to it in the UI. The existing events include `init-progress`, `sync-finished`, `automation-finished`, `fork-sync-finished` and `pty-data`.
6. For a new synced table, add a `db.rs` migration, add it to the synced tables in `sync.rs`, and update the iOS models if the phone should see it.
7. Update the matching page in `docs/`.

## Conventions

- **Errors**:
  - Rust commands return `Result` and never panic on user input. Lock mutexes with `.lock_ok()` from `error::LockExt`, not `.lock().unwrap()`.
  - In the UI, never write an empty `catch`. Use `reportError(title)` when the user should know, which shows a toast and logs. Use `logError(context, fallback)` for best-effort calls such as badges, counts and background refreshes.
- Periodic work runs on the single loop in `scheduler.rs`. Each subsystem exposes `jobs() -> Vec<Job>` (`Job::every` / `Job::once`), registered in `lib.rs` `setup`. Never spawn your own `loop { sleep }`.
- `watch.rs` watches each project's `.git` dir and `refs/` and emits `git-changed` with project ids. The store refreshes those cards, and `useGitChanged` (`src/lib/gitEvents.ts`) lets a view react. `git status` runs with `--no-optional-locks` so a refresh never rewrites the index and re-triggers the watcher.
- `refreshAllStatuses` runs at most 4 `git status` at a time, on-screen cards first (`setCardVisible`).
- Synced tables need `id` (PK or unique), `updated_at`, `deleted`, `dirty`; add the table to `TABLES` in `sync.rs` (and to the iOS `PgSchema.allTables` if the phone uses it). Columns added later reach existing servers through the generated `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. Local-only columns in a synced table (e.g. fork check results) just stay out of `cols`.
- Edits that lose on push (server already newer) are copied to `sync_conflicts`; Settings lets the user restore them.
- Archived projects (`archived_at`) are skipped by background work: use `db::active_projects`, not `list_projects`, for anything that runs on its own.
- `backup.rs`: JSON/SQLite export, merge-import (never overwrites newer rows, marks imports dirty), daily `VACUUM INTO` snapshots in `<app data>/backups` (keeps 7). New tables worth keeping go in its `TABLES` list.
- `git_share.rs` writes a `project_git` row per project (only when it changed and sync is connected) for the iPhone's read-only Git tab.
- `activity.rs`: the dashboard feed. Commits and fork events go in the local `activity` table (commits found by scanning since the last scan, triggered by the watcher). Automation runs and done to-dos are read straight from their tables in one UNION query.
- `github.rs` talks to GitHub only through the user's `gh` CLI (no tokens in the app), caches 5 min, and emits `github-status`. A missing `gh`, a sign-out or a non-GitHub remote come back as `available: false` with a `reason`, never as errors.
- `worktree.rs`: `git worktree` list/add/remove (the main worktree is protected). New git features that don't touch the status or log code go in their own module rather than growing `git.rs`.
- Event triggers (`files`, `branch`, `push`, `fork`) carry an optional `trigger_filter` (globs, `automations/triggers.rs`). The watcher also watches a project's working tree, but only for projects targeted by an enabled `files` automation. `automation_runtime::git_events` tells branch switches and pushes apart from fetches and pulls.
- `notify::send(app, kind, …)` is the only way to show a system notification; it honours the `notify.<kind>` setting.
- `search.rs` backs the palette's "Found in your projects". `import.rs` uses `cli::add_folder`, the same code path as `bluephoenix add`.
- Custom wizard templates (`templates.rs`, synced `project_templates`) store a tokenized plan (`{{name}}`, `{{folder}}`, `{{identifier}}`, `{{description}}`, `{{version}}`); `src/lib/initializer/custom.ts` converts both ways.
- Postgres integration tests: `BP_TEST_PG=postgresql://user@localhost:5544/postgres?sslmode=disable cargo test pg_integration -- --test-threads=1`.
- Git always goes through the system `git` CLI, so the user's credentials and SSH keys work. Fork conflict prediction needs git 2.38 or newer, for `merge-tree --write-tree`.
- Secrets (AI keys, the database URL) live in the OS keychain through `keyring`, never in SQLite.
- UI text is plain and friendly. Colours come from CSS variables (`var(--fg-muted)`, `var(--accent)`, `var(--line)` and so on) so both themes work.

## Commands

```bash
scripts/dev.sh                      # run the app with hot reload (pnpm tauri dev)
npm run typecheck                   # tsc --noEmit
npm test                            # vitest (src/lib/**/*.test.ts)
(cd src-tauri && cargo test)        # Rust unit tests
(cd src-tauri && cargo clippy --all-targets)
scripts/build-macos.sh [--universal] / build-windows.ps1 / build-linux.sh / build-ios.sh
```

## Releasing

1. Run `scripts/bump-version.sh x.y.z`. It sets the version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `ios/project.yml` and the README badge, then refreshes `Cargo.lock`.
2. Build and upload the installers.
3. Update `bluephoenix-v.json` and `bluephoenix-d.json` in the `montanari-luca/MintFlow-Releases` repo. `src-tauri/src/updater.rs` reads those two files.
