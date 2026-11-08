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
- Background loops start in `lib.rs` `setup` (`sync`, `automation_runtime` and `fork_sync`, each with `start_background`).
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
