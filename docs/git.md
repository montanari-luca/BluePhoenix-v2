# Git

BluePhoenix uses the `git` program installed on your computer, so your existing sign-in (SSH keys, credential helper) just works. BluePhoenix never asks for your password; if git needs one it will show an error instead of waiting.

## Quick actions

Available from the dashboard card **⋯** menu, the project page, and the [command palette](command-palette.md):

| Action | What it does |
| --- | --- |
| **Fetch** | Downloads new commits from every remote without changing your files. Refreshes the "to pull" count. |
| **Pull** | Fetches and merges the remote branch into your current branch. |
| **Push** | Uploads your commits. If the branch has no upstream yet, it is created on `origin`. |
| **Stash changes** | Puts your uncommitted work (including new files) aside. |
| **Apply last stash** | Brings the most recent stash back. |

A toast in the corner shows the result or the exact git error.

## The Git tab

Open a project and choose **Git**.

### Changes

- Every changed file is listed with a letter: **M** modified, **A** added, **D** deleted, **R** renamed, **?** new, **U** conflict.
- Tick the box to stage a file, untick to unstage. **Stage all** and **Unstage all** do it in bulk.
- Click a file name to see its diff.
- Write a message and press **Commit**, or **Commit & push**. Press **Generate** to let [AI](ai.md) write the message from your staged changes.

### Branches

- See local and remote branches with their last commit.
- **Create & switch** makes a new branch from where you are.
- **Switch** checks out a branch (remote branches get a local tracking copy).
- **More → Merge … into current** merges a branch into the one you are on. If it conflicts, resolve the files in your editor, or use **Abort merge**.
- **More → Delete branch** removes a local branch.

### History

The latest commits. Click one to see its full change. **Load more** goes further back.

### Stashes

Create a stash or apply the latest one, and see the full stash list.

## Pull requests and CI

With the GitHub CLI (`gh`) installed and signed in, the Git tab of a project on GitHub shows its open pull requests (draft, review status, "your review" when you are asked) and the latest CI run on the current branch. Click a pull request to open it on GitHub; the refresh button checks again right away.

## Worktrees

**Git tab → Worktrees** lists every checkout of the repository. **New worktree** checks out a new or existing branch into its own folder (by default next to the project, named `<project>-<branch>`), so you can, for example, fix a bug on `main` without stashing your half-done feature. Each worktree has buttons to open it in your editor or terminal, reveal it, or remove it (the branch is kept; you are asked before discarding uncommitted changes).

## GitHub forks

Fork settings (the upstream address, branch and auto-check options) sync to your other computers; each computer keeps its own check results.

In **Edit project** (or when adding one), turn on **This project is a GitHub fork**. The Git tab then shows an **Upstream** card for the original repository.

- **Check now** fetches upstream and reports one of: *up to date*, *safe to pull* (the new commits merge cleanly), *conflicting* (they clash with your commits) or *conflicts not tested*. The check never touches your files.
- **Pull upstream** merges the new commits. It only runs when they are safe and you have no uncommitted changes.
- **Check for upstream changes automatically** repeats the check in the background while BluePhoenix is open: every hour, 6 hours, 12 hours, 24 hours, 3 days, a week, or a **custom** number of minutes, hours or days (at least 15 minutes).
- **Pull when it is safe** also merges safe changes by itself. Conflicting changes are only flagged, never merged. A notification tells you when something new is found.

**Older git (before 2.38).** Predicting conflicts uses `git merge-tree --write-tree`, which arrived in git 2.38. With an older git the card says *Conflict prediction needs git 2.38+ (you have …)* and new commits show as *conflicts not tested*; ahead/behind counts still work. **Pull upstream** (and **Pull when it is safe**) then simply tries the merge — still only with no uncommitted changes — and undoes it with `git merge --abort` if it conflicts, so your branch is left as it was. Update git to get the prediction back.

BluePhoenix looks for a remote named `upstream` (change the name, the branch, or give a URL to have it added under **Upstream remote**). Without a chosen branch it compares with the branch you have checked out, then `main`, then `master`. The project card on the dashboard shows the latest result.

## Not a git repository?

The Overview and Git tabs offer **git init** for folders that are not under git yet.
