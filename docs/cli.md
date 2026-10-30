# Command line

BluePhoenix installs a `bluephoenix` command you can use from any terminal.

## Installing

The command installs itself the first time you run BluePhoenix and repairs itself after the app moves or updates. You can also manage it in **Settings → Command line** (Install, Reinstall, Remove). Open a **new** terminal window after the first install.

It needs no administrator rights:

| System | What is installed |
| --- | --- |
| macOS, Linux | A small launcher at `~/.local/bin/bluephoenix`. If that folder is not on your `PATH`, BluePhoenix adds a clearly marked block to your shell's startup file (`.zshrc`, `.bashrc` / `.bash_profile`, `.profile` or the fish config). |
| Windows | A console copy of the app at `%LOCALAPPDATA%\BluePhoenix\bin\bluephoenix.exe`, and that folder is added to your user `PATH`. |

**Remove** deletes the launcher and the startup block, and stops BluePhoenix from installing it again.

BluePhoenix must have been opened at least once, so its settings and database exist.

## Commands

### `bluephoenix commit`

Run it inside a git repository (any subfolder works). It:

1. runs `git add .` for the whole repository,
2. asks the AI model chosen in **Settings → AI** to write a commit message from the staged changes (lockfiles are left out of what the model sees),
3. runs `git commit` with that message.

With `-push` (also `--push` or `-p`) it then runs `git push`. If the branch has no upstream yet, it pushes with `-u origin HEAD`, the same as the Push button in the app.

```bash
bluephoenix commit
bluephoenix commit -push
```

If a local provider (Ollama or LM Studio) is selected and not running, it is started first, just like when the app opens. If the model call fails, your changes stay staged and nothing is committed. If there is nothing to commit, no message is generated (and with `-push` it still pushes).

### `bluephoenix add`

Adds the current folder (or `bluephoenix add <path>`) as a project, exactly like **Add project** in the app: it detects the type, description, GitHub remote and build commands, then indexes the files. A folder that is already a project is left alone. If the folder has a `.bluephoenix` file (see [Projects](projects.md#the-bluephoenix-file)), its settings and commands are restored from it; otherwise one is created.

If BluePhoenix is open, the new project appears when you switch back to its window.

## Other options

```bash
bluephoenix --help
bluephoenix --version
bluephoenix commit --help
```

Exit codes: `0` success, `1` the command failed, `2` wrong usage.
