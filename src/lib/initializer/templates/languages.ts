// Plain language projects: Rust, Python, Go, Node + TypeScript, Flutter.
import type { Step, Template } from "../types";
import { slugify, snake, parseDeps, sel, run, add, cargoVersion, GITIGNORE_NODE, nodeTools, RUST_TOOL, NODE_DEPS } from "../helpers";

export const rust: Template = {
  id: "rust",
  name: "Rust",
  blurb: "Binary or library crate",
  group: "Languages",
  icon: "Cog",
  kind: "Rust",
  options: [
    {
      id: "crate",
      label: "Crate type",
      type: "select",
      choices: [
        { value: "bin", label: "Binary" },
        { value: "lib", label: "Library" },
      ],
      default: "bin",
    },
  ],
  usesPm: false,
  depGroups: [{ id: "deps", label: "Crates", placeholder: "serde tokio anyhow" }],
  icons: [],
  tools: () => [RUST_TOOL],
  build(c) {
    const steps: Step[] = [
      run("Create the crate", "cargo", ["new", c.folder, `--${sel(c, "crate")}`, "--vcs", "none"], "parent"),
      cargoVersion(c),
    ];
    const deps = parseDeps(c.deps.deps);
    if (deps.length) steps.push(run(`Add ${deps.join(", ")}`, "cargo", ["add", ...deps], "project"));
    return steps;
  },
  commands: (c) => (sel(c, "crate") === "bin" ? [{ label: "Run", command: "cargo run" }, { label: "Test", command: "cargo test" }] : [{ label: "Test", command: "cargo test" }]),
};

export const python: Template = {
  id: "python",
  name: "Python",
  blurb: "Project managed with uv (virtualenv, pyproject.toml)",
  group: "Languages",
  icon: "FileCode2",
  kind: "Python",
  options: [
    {
      id: "layout",
      label: "Layout",
      type: "select",
      choices: [
        { value: "app", label: "Application" },
        { value: "package", label: "Package (src layout)" },
        { value: "lib", label: "Library" },
      ],
      default: "app",
    },
    {
      id: "python",
      label: "Python version",
      type: "select",
      choices: [
        { value: "", label: "Latest installed" },
        { value: "3.14", label: "3.14" },
        { value: "3.13", label: "3.13" },
        { value: "3.12", label: "3.12" },
        { value: "3.11", label: "3.11" },
      ],
      default: "",
    },
  ],
  usesPm: false,
  depGroups: [
    { id: "deps", label: "Packages", placeholder: "requests fastapi" },
    { id: "dev", label: "Dev packages", placeholder: "pytest ruff" },
  ],
  icons: [],
  tools: () => [{ program: "uv", hint: "curl -LsSf https://astral.sh/uv/install.sh | sh", required: true }],
  build(c) {
    const py = sel(c, "python");
    const steps: Step[] = [
      run("Create the project", "uv", ["init", c.folder, `--${sel(c, "layout")}`, "--vcs", "none", ...(py ? ["--python", py] : [])], "parent"),
      {
        kind: "replace",
        label: "Set version in pyproject.toml",
        file: "pyproject.toml",
        pattern: String.raw`(?m)^version\s*=\s*"[^"]*"`,
        replacement: `version = "${c.version}"`,
      },
      { kind: "write", label: "Write .gitignore", path: ".gitignore", contents: ".venv/\n__pycache__/\n*.pyc\n.pytest_cache/\n.ruff_cache/\ndist/\n*.egg-info/\n.env\n.DS_Store\n" },
    ];
    const deps = parseDeps(c.deps.deps);
    const dev = parseDeps(c.deps.dev);
    if (deps.length) steps.push(run(`Add ${deps.join(", ")}`, "uv", ["add", ...deps], "project"));
    if (dev.length) steps.push(run(`Add ${dev.join(", ")} (dev)`, "uv", ["add", "--dev", ...dev], "project"));
    if (!deps.length && !dev.length) steps.push(run("Create the virtual environment", "uv", ["sync"], "project", true));
    return steps;
  },
  commands: (c) => (sel(c, "layout") === "app" ? [{ label: "Run", command: "uv run main.py" }] : []),
};

export const go: Template = {
  id: "go",
  name: "Go",
  blurb: "Go module with a main package",
  group: "Languages",
  icon: "Zap",
  kind: "Go",
  options: [],
  identifier: { label: "Module path", placeholder: (c) => `github.com/you/${slugify(c.name) || "app"}` },
  noVersion: true,
  usesPm: false,
  depGroups: [{ id: "deps", label: "Modules", placeholder: "github.com/gin-gonic/gin" }],
  icons: [],
  tools: () => [{ program: "go", hint: "Install Go from go.dev", required: true }],
  build(c) {
    const steps: Step[] = [
      run("Initialize the module", "go", ["mod", "init", c.identifier], "project"),
      { kind: "write", label: "Write main.go", path: "main.go", contents: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, world!")\n}\n' },
      { kind: "write", label: "Write .gitignore", path: ".gitignore", contents: "bin/\n*.exe\n*.test\n*.out\n.env\n.DS_Store\n" },
    ];
    const deps = parseDeps(c.deps.deps);
    if (deps.length) steps.push(run(`Add ${deps.join(", ")}`, "go", ["get", ...deps], "project"));
    steps.push(run("Tidy modules", "go", ["mod", "tidy"], "project", true));
    return steps;
  },
  commands: () => [{ label: "Run", command: "go run ." }, { label: "Test", command: "go test ./..." }],
};

export const nodeTs: Template = {
  id: "node",
  name: "Node.js + TypeScript",
  blurb: "Library or command-line tool",
  group: "Languages",
  icon: "Hexagon",
  kind: "Node.js",
  options: [
    {
      id: "layout",
      label: "Kind",
      type: "select",
      choices: [
        { value: "lib", label: "Library" },
        { value: "cli", label: "Command-line tool" },
      ],
      default: "lib",
    },
  ],
  usesPm: true,
  depGroups: NODE_DEPS,
  icons: [],
  tools: (c) => nodeTools(c).filter((t) => t.program !== "npx" || c.pm !== "npm"),
  build(c) {
    const cli = sel(c, "layout") === "cli";
    const pkg: Record<string, unknown> = {
      name: slugify(c.name),
      version: c.version,
      ...(c.description.trim() ? { description: c.description.trim() } : {}),
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      ...(cli ? { bin: { [slugify(c.name)]: "dist/index.js" } } : {}),
      files: ["dist"],
      scripts: { build: "tsc", dev: "tsc --watch", start: "node dist/index.js", typecheck: "tsc --noEmit" },
    };
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        outDir: "dist",
        rootDir: "src",
        strict: true,
        declaration: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ["src"],
    };
    const index = cli
      ? '#!/usr/bin/env node\n\nconsole.log("Hello from ' + slugify(c.name) + '!");\n'
      : "export function hello(name = \"world\"): string {\n  return `Hello, ${name}!`;\n}\n";
    const steps: Step[] = [
      { kind: "write", label: "Write package.json", path: "package.json", contents: JSON.stringify(pkg, null, 2) + "\n" },
      { kind: "write", label: "Write tsconfig.json", path: "tsconfig.json", contents: JSON.stringify(tsconfig, null, 2) + "\n" },
      { kind: "write", label: "Write src/index.ts", path: "src/index.ts", contents: index },
      { kind: "write", label: "Write .gitignore", path: ".gitignore", contents: GITIGNORE_NODE },
      add(c.pm, ["typescript", "@types/node", ...parseDeps(c.deps.dev)], true, "Add TypeScript tooling"),
    ];
    const deps = parseDeps(c.deps.deps);
    if (deps.length) steps.push(add(c.pm, deps, false, `Add ${deps.join(", ")}`));
    return steps;
  },
  commands: (c) => [{ label: "Dev", command: `${c.pm} run dev` }, { label: "Build", command: `${c.pm} run build` }],
};

export const flutter: Template = {
  id: "flutter",
  name: "Flutter",
  blurb: "Cross-platform app: iOS, Android, web and desktop",
  group: "Desktop & mobile",
  icon: "Bird",
  kind: "Flutter",
  options: [],
  identifier: { label: "Organization", placeholder: () => "com.example" },
  usesPm: false,
  depGroups: [
    { id: "deps", label: "Packages", placeholder: "provider http" },
    { id: "dev", label: "Dev packages", placeholder: "mocktail" },
  ],
  icons: ["apple", "android", "windows", "flutter-web"],
  tools: () => [{ program: "flutter", hint: "Install Flutter from flutter.dev", required: true }],
  build(c) {
    const steps: Step[] = [
      run("Create the Flutter app", "flutter", ["create", c.folder, "--org", c.identifier, "--project-name", snake(c.name), "--description", c.description.trim() || c.name.trim()], "parent"),
      {
        kind: "replace",
        label: "Set version in pubspec.yaml",
        file: "pubspec.yaml",
        pattern: String.raw`(?m)^version:.*$`,
        replacement: `version: ${c.version}+1`,
      },
    ];
    const deps = parseDeps(c.deps.deps);
    const dev = parseDeps(c.deps.dev);
    if (deps.length) steps.push(run(`Add ${deps.join(", ")}`, "flutter", ["pub", "add", ...deps], "project"));
    if (dev.length) steps.push(run(`Add ${dev.join(", ")} (dev)`, "flutter", ["pub", "add", "--dev", ...dev], "project"));
    return steps;
  },
  commands: () => [{ label: "Run", command: "flutter run" }, { label: "Test", command: "flutter test" }],
};
