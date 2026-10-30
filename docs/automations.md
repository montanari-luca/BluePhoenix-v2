# Automations

Automations run shell commands inside your projects for you: clean old build folders, pull when it is safe, fetch every remote. Open **Automations** in the top bar.

Each automation is a card. Click a card to edit it, flip its switch to pause it, or use **Run now** to run it right away.

## Create one

Click **New automation** to start from an empty one. The arrow on its right offers:

- **Create empty automation**: the same as clicking the button.
- **Start from a template**: pick a ready-made automation and adjust it.

| Setting | What it does |
| --- | --- |
| Name, description | The description is optional. |
| Run | When it runs (see below). |
| Date and time | For a scheduled automation, the first run. For the others, "not before" this moment. |
| Repeat every | Runs again once this many hours or days passed since the last run in that project. |
| Alert | Optional system notification: when it runs, or (scheduled only) some minutes before. |
| Projects | Selected projects, or all projects, optionally narrowed to one type such as Tauri. |
| Requisites | Conditions a project must meet, otherwise it is skipped (see below). |
| Commands | Run in each project's folder, in your shell. New lines or `&&` chain commands. |

## When it runs

| Trigger | Runs |
| --- | --- |
| When launching BluePhoenix | A few seconds after the app starts, if the date or repeat is due. |
| When quitting BluePhoenix | When you close the app, if due. Quitting waits up to a minute for it to finish. |
| On a schedule | While BluePhoenix is open, checked every minute. |
| After a commit | After you commit in BluePhoenix, for the project you committed in. |
| Manual run only | Only with **Run now**. |

With no date and no repeat, an automation runs every time its trigger fires. With a repeat it runs again only after the interval, tracked per project. With only a date it runs once.

Quit automations do not run if BluePhoenix crashes, and commits made from a terminal (`bluephoenix commit` included) do not trigger "after a commit" yet.

## Requisites

| Requisite | The project is skipped when |
| --- | --- |
| Not edited in the past N hours | Any file changed in that time. `.git`, `node_modules` and ignored files such as build output do not count. |
| Git working tree is clean | There are uncommitted changes. |
| Project is a git repository | There is no `.git` folder. |

Skipped projects are not marked as done, so they are checked again next time. **Run now** also respects requisites and tells you why a project was skipped.

## Templates

| Template | What it does |
| --- | --- |
| Cargo clean | Every 48h at launch, `cargo clean` in `src-tauri` of Tauri projects not edited for 48h. |
| Git pull | At every launch, pulls in git projects, only when there are no local changes. |
| Git fetch all | Every 6h at launch, `git fetch --all --prune` in git projects. |
| Rust target cleanup | Every 48h at launch, `cargo clean` in Rust projects not edited for 48h. |
| Node cleanup | Weekly at launch, removes `node_modules` from Node.js projects not edited for 14 days. Reinstall when you return. |

The templates use POSIX shell syntax. On Windows, commands run in PowerShell, so edit them first (for example, `Remove-Item -Recurse node_modules`).

## Results

The card shows the last run. Open an automation to see **Recent runs** with each project's status and output. Runs go through your login shell, so tools like `cargo` and `git` are found as in your terminal. A run is stopped after 15 minutes.

Automations are stored only on this computer. They are not part of [cloud sync](sync.md), because commands should not travel between devices.
