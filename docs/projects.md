# Projects

## Add a project

See [Getting started](getting-started.md#add-your-first-project). BluePhoenix reads your folder to suggest:

- the **name** and **description** (from `package.json`, `Cargo.toml`, `pyproject.toml` and similar)
- the **type**: Node.js, React, Vite, Next.js, Tauri, Rust, Python, Django, Go, Java (Maven/Gradle), PHP, Laravel, Flutter, Swift, .NET, Ruby, C/C++ and more
- the **GitHub address** from your `origin` remote
- **commands** from `package.json` scripts (using the package manager your lockfile indicates), Cargo, Makefile, justfile, Go, Maven, Gradle, Composer, Flutter, Docker Compose and others

If nothing useful is found, add commands yourself, or press **Scan with AI** (see [AI features](ai.md)).

### The `.bluephoenix` file

When you add a project that has a folder, BluePhoenix writes a `.bluephoenix` file into it with the project's name, description, type, links, default editor and terminal, and the commands you picked. If you later remove the project and add the folder again (in the app or with `bluephoenix add`), these settings are restored from the file instead of being detected again.

The file is plain JSON. BluePhoenix does not add it to `.gitignore`, so you can commit it and share the setup with your team. If you would rather not, ignore it yourself. The file is only written when a project is added; later edits in the app do not update it.

## Start a new project

No code yet? **New project** scaffolds one for you, including dependencies, app icons and a git repository. See the [New project wizard](new-project.md).

## Edit a project

Open the project and choose **Edit project…** from the **⋯** menu. You can change the name, description, type, folder, GitHub and website links, and the project's own default editor and terminal.

## Favourites

Star a project from its card or its page. The command palette also has *Add to favorites*.

## Archive a project

Finished with something but want to keep its history? Use **⋯ → Archive project**. It disappears from the dashboard, the command palette and all background work (status refreshes, automations, fork checks), but keeps its to-dos, notes and time. Archived projects are listed under **Archived** on the dashboard; restore one from its ⋯ menu. Archiving syncs, so it applies on your other devices and the iPhone too.

## Remove a project

**⋯ → Remove project**. This only removes it from BluePhoenix, along with its to-dos, notes and time entries. **Your files on disk are never touched.**

## Projects without a folder

Choose **Track something without a folder** when adding. Good for courses, research, design work or anything you want to plan and time-track. Git, terminal, file and command features are switched off for these projects.
