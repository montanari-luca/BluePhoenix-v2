# New project wizard

Start a project from scratch without leaving BluePhoenix. Click **New project** on the dashboard (or run *New project…* from the [command palette](command-palette.md)).

## How it works

1. **Pick a type.** Tauri v2, React, Next.js, Astro, Vue, SvelteKit, Expo, Flutter, SwiftUI, Rust, Python, Go or Node.js + TypeScript.
2. **Fill in the details.**
   - **Name**, **folder name** and **Create in** (the parent folder; BluePhoenix remembers your choice).
   - **Version** (written into `package.json`, `Cargo.toml`, `tauri.conf.json`, `app.json`, `pubspec.yaml`, `pyproject.toml` or the Xcode project, depending on the type).
   - **Bundle identifier** (or Go module path, Flutter organization) where the type needs one.
   - **Framework and language**: for example the frontend of a Tauri app (React, Vue, Svelte, Solid, Preact, Vanilla, Angular, Leptos, Yew, Sycamore) and TypeScript or JavaScript, or the UI framework of an Astro site.
   - **Type-specific options**, such as Tailwind CSS, ESLint, router and `src/` folder for Next.js, platforms for SwiftUI, or library vs. binary for Rust.
   - **Package manager** (pnpm, npm, yarn or bun; only the ones you have installed are suggested).
   - **Extra dependencies**: packages, dev packages, Rust crates or Swift packages. They are installed for you.
   - **App icon**: one image, converted for every platform (see below).
   - **Git**: initialize a repository with a first commit, choose the branch name, and optionally create a private or public GitHub repository with the [GitHub CLI](https://cli.github.com) (`gh`).
3. **Create.** BluePhoenix runs the scaffolding command, edits the version, installs dependencies, generates icons and commits. Each step shows its status, and the command output streams into a log.

When it finishes, the project is added to BluePhoenix with its commands (dev server, build, test and so on) and opens. A `.bluephoenix` file is written into the folder like for any [added project](projects.md#the-bluephoenix-file).

Expand **Steps that will run** before you create to see every command.

## Your own templates

When a setup is the way you like it, press **Save as template…** at the bottom of the wizard. It keeps the steps, extra dependencies and generated files; next time it appears under **My templates** and you only enter a name (the project name, folder and identifier are filled into the saved steps). Git, GitHub and icons are still chosen each time.

Templates sync to your other computers. Use a template's **⋯** menu to **Export** it as a `.json` file for a teammate, and **Import template…** at the top of the wizard to add one. Every step is checked before it runs, the same as the built-in templates.

## Icons

Choose a PNG, JPEG, WebP, GIF, BMP or ICO image. A square PNG of 1024×1024 or more gives the best result; other shapes are centered on a transparent square. The icons depend on the project type:

| Type | Generated |
| --- | --- |
| Tauri | `src-tauri/icons` (PNG sizes, `icon.ico`, `icon.icns`, Windows Store logos) and `app-icon.png` |
| React, Vue, Next.js, Astro, SvelteKit | `favicon.ico`, PNG favicons, Apple touch icon, 192 and 512 px icons, and any starter favicon is replaced |
| SwiftUI | the full `AppIcon.appiconset` for iOS and macOS (iOS icons are flattened onto white, as the App Store requires) |
| Expo | the icon, adaptive icon, splash icon and favicon in `assets` |
| Flutter | iOS, macOS, Android, Windows and web icons |

## Requirements

The wizard uses the tools of the type you pick and tells you when one is missing: Node.js with your package manager, Rust (`cargo`), `uv` for Python, Go, Flutter, or [XcodeGen](https://github.com/yonaskolb/XcodeGen) for SwiftUI (`brew install xcodegen`). Scaffolders that download templates (such as `create-tauri-app`) need an internet connection.

## If a step fails

The log shows what went wrong. Choose **Retry from this step**, go **Back to settings**, or **Add folder as a project** to keep what was created. A failed commit (for example when git has no name and email configured) or a missing icon location only produces a warning; the project is still created.
