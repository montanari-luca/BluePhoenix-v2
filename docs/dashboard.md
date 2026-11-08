# The dashboard

The dashboard lists all your projects as cards. Starred projects and recently opened ones come first.

## What a card shows

- **Title** and, if you wrote one, a short **description**. The project type (for example Tauri or Python) appears next to the title.
- **Branch row:** the branch your folder is on right now (not the repository's default branch) and its state:

  | Badge | Meaning |
  | --- | --- |
  | **Up to date** | Nothing to commit, nothing to push or pull. |
  | **N uncommitted changes** | You have edited, staged or new files. |
  | **N to push** | You have commits that are not on the remote yet. |
  | **N to pull** | The remote has commits you do not have. Run **Fetch** first to refresh this number. |
  | **Diverged** | Both of the above. |
  | **N conflicts** | A merge needs your attention. |
  | **No upstream** | The branch is not linked to a remote branch yet. A push will set that up. |
  | **Not a git repo** | The folder is not under git. Open the project's Git tab to run `git init`. |

- **Facts:** total time tracked, number of open to-dos, and when the project was last updated (the newest of your last commit, to-do or time entry).
- **Actions** below the divider:
  - **Open in …** opens the folder in your default editor. The arrow lets you pick another editor, the embedded terminal, your system terminal, or reveal the folder.
  - **Run command** (blue) runs the project's main command, usually the build. The arrow lists all the project's commands so you can run another one instead.

## Star and menu

- The **star** at the top right of a card adds the project to your favourites. Use the **Favorites** filter at the top of the dashboard to show only those.
- The **⋯** menu has: open in terminal, reveal folder, fetch, pull, push, stash changes, apply last stash, open GitHub, open website, edit and remove project.

Click anywhere else on the card to open the full project page.

## Git for all projects

The **Git** menu next to the search box works on every (non-archived) project at once, four at a time, with one summary at the end:

- **Fetch all** downloads new commits from every remote.
- **Pull all clean projects** fast-forwards projects that have no local changes and an upstream branch. It never creates merge commits; a project whose branch has diverged is reported and left alone.
- **Only show unpushed** filters the dashboard to projects with commits you have not pushed yet.

## Pull requests and CI

If the [GitHub CLI](https://cli.github.com) (`gh`) is installed and signed in (`gh auth login`), cards of projects on GitHub show the number of open pull requests, how many wait for your review, and whether the latest CI run on the current branch passed. Click the CI label to open the run. This refreshes every five minutes; nothing is sent to BluePhoenix servers.

## Activity

The **activity** button (next to the Git menu) opens a timeline of what happened across your projects: commits, automation runs, fork updates and completed to-dos, grouped by day. Filter by kind, and click an entry to jump to the project. Commits are picked up as you make them (from any terminal or editor); the first time, the last seven days are filled in. Activity stays on this computer and is kept for 90 days.

## Archived projects

The filter next to the search box shows **Archived** once you have archived something. Archived cards look the same; restore one with **⋯ → Restore from archive**. See [Projects](projects.md#archive-a-project).

## Keeping it fresh

Branch states update by themselves within a second of a commit, checkout, stage, fetch or push, even one you make in another terminal or editor. Edits to your files show up when you bring the window back to the front, and everything is rechecked every five minutes as a safety net.
