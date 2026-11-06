// Templates for the "New project" wizard. A template turns the wizard's answers into a plan: an
// ordered list of steps (commands, small file edits, icons, git) that the backend runs.

export type Pm = "pnpm" | "npm" | "yarn" | "bun";

export type Step =
  | { kind: "run"; label: string; program: string; args: string[]; cwd?: string; optional?: boolean; expects?: string }
  | { kind: "write"; label: string; path: string; contents: string }
  | { kind: "jsonSet"; label: string; file: string; sets: { path: string; value: unknown }[]; optional?: boolean }
  | { kind: "replace"; label: string; file: string; pattern: string; replacement: string; optional?: boolean }
  | { kind: "icons"; label: string; source: string; targets: string[] }
  | { kind: "git"; label: string; message: string; branch: string; commit: boolean };

export interface Choice {
  value: string;
  label: string;
}

export interface TemplateOption {
  id: string;
  label: string;
  type: "select" | "toggle";
  choices?: Choice[];
  default: string | boolean;
}

export interface DepGroup {
  id: string;
  label: string;
  placeholder: string;
}

export interface Tool {
  program: string;
  hint: string;
  required: boolean;
}

export interface InitConfig {
  name: string;
  folder: string;
  parent: string;
  version: string;
  description: string;
  identifier: string;
  framework: string;
  language: string;
  options: Record<string, string | boolean>;
  pm: Pm;
  deps: Record<string, string>;
  icon: string | null;
  git: boolean;
  branch: string;
  /** "" = do not create a GitHub repository */
  github: "" | "private" | "public";
}

export interface Template {
  id: string;
  name: string;
  blurb: string;
  group: "Desktop & mobile" | "Web" | "Apple" | "Languages";
  /** lucide icon key, resolved by the dialog */
  icon: string;
  /** Project type shown in BluePhoenix */
  kind: string;
  frameworkLabel?: string;
  frameworks?: Choice[];
  languages?: Choice[];
  /** Whether the language choice applies for the current answers. */
  languageApplies?: (c: InitConfig) => boolean;
  options: TemplateOption[];
  identifier?: { label: string; placeholder: (c: InitConfig) => string };
  /** Version is not part of the project files (Go uses git tags). */
  noVersion?: boolean;
  usesPm: boolean;
  depGroups: DepGroup[];
  icons: string[];
  tools: (c: InitConfig) => Tool[];
  build: (c: InitConfig) => Step[];
  commands?: (c: InitConfig) => { label: string; command: string }[];
}

// ---------- helpers ----------

export const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

/** "my cool app" -> "MyCoolApp" (a valid Swift type name). */
export const pascal = (name: string) => {
  const p = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return /^[0-9]/.test(p) ? `App${p}` : p || "App";
};

export const snake = (name: string) => slugify(name).replace(/[^a-z0-9]+/g, "_").replace(/^(\d)/, "app_$1");

export const parseDeps = (text: string | undefined) =>
  (text ?? "")
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const REVERSE_DNS = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;

const sel = (c: InitConfig, id: string) => String(c.options[id] ?? "");
const on = (c: InitConfig, id: string) => c.options[id] === true;

const run = (label: string, program: string, args: string[], cwd?: string, optional?: boolean): Step => ({
  kind: "run",
  label,
  program,
  args,
  cwd,
  optional,
});

/** Runs a package from the registry (npm create ...), like `npx` / `pnpm dlx`. */
function dlx(pm: Pm, pkg: string, args: string[], label: string, expects = "package.json"): Step {
  // Some scaffolders exit 0 when they cannot ask a question, so check that they produced the project.
  const base = pm === "pnpm" ? run(label, "pnpm", ["dlx", pkg, ...args], "parent") : pm === "bun" ? run(label, "bunx", [pkg, ...args], "parent") : run(label, "npx", ["--yes", pkg, ...args], "parent");
  return { ...base, expects } as Step;
}

/** Runs a binary installed in the project (npx vite ...). */
function exec(pm: Pm, args: string[], label: string): Step {
  if (pm === "pnpm") return run(label, "pnpm", ["exec", ...args], "project");
  if (pm === "bun") return run(label, "bunx", args, "project");
  return run(label, "npx", ["--yes", ...args], "project");
}

const install = (pm: Pm): Step => run(`Install dependencies (${pm})`, pm, ["install"], "project");

function add(pm: Pm, pkgs: string[], dev: boolean, label: string): Step {
  const flag = dev ? [pm === "bun" ? "-d" : "-D"] : [];
  return run(label, pm, [pm === "npm" ? "install" : "add", ...flag, ...pkgs], "project");
}

/** Install plus the user's extra packages, for any Node project. */
function nodeDeps(c: InitConfig): Step[] {
  const steps: Step[] = [install(c.pm)];
  const deps = parseDeps(c.deps.deps);
  const dev = parseDeps(c.deps.dev);
  if (deps.length) steps.push(add(c.pm, deps, false, `Add ${deps.join(", ")}`));
  if (dev.length) steps.push(add(c.pm, dev, true, `Add ${dev.join(", ")} (dev)`));
  return steps;
}

function packageJson(c: InitConfig, file = "package.json"): Step {
  const sets: { path: string; value: unknown }[] = [{ path: "version", value: c.version }];
  if (c.description.trim()) sets.push({ path: "description", value: c.description.trim() });
  return { kind: "jsonSet", label: "Set version and description", file, sets, optional: true };
}

const cargoVersion = (c: InitConfig, file = "Cargo.toml"): Step => ({
  kind: "replace",
  label: "Set version in Cargo.toml",
  file,
  pattern: String.raw`(?m)^version\s*=\s*"[^"]*"`,
  replacement: `version = "${c.version}"`,
});

const GITIGNORE_NODE = "node_modules\ndist\n.env\n.env.local\n.DS_Store\n*.log\n";

const nodeTools = (c: InitConfig): Tool[] => {
  const hint = (p: string) => ({ pnpm: "npm i -g pnpm", npm: "Install Node.js from nodejs.org", yarn: "npm i -g yarn", bun: "Install from bun.sh" })[p] ?? "";
  const tools: Tool[] = [{ program: c.pm, hint: hint(c.pm), required: true }];
  if (c.pm === "bun") tools.push({ program: "bunx", hint: hint("bun"), required: true });
  if (c.pm === "npm" || c.pm === "yarn") tools.push({ program: "npx", hint: hint("npm"), required: true });
  return tools;
};

const RUST_TOOL: Tool = { program: "cargo", hint: "Install Rust from rustup.rs", required: true };

const LANG_TS_JS: Choice[] = [
  { value: "ts", label: "TypeScript" },
  { value: "js", label: "JavaScript" },
];

const NODE_DEPS: DepGroup[] = [
  { id: "deps", label: "Extra dependencies", placeholder: "zustand react-router-dom" },
  { id: "dev", label: "Extra dev dependencies", placeholder: "vitest prettier" },
];

// ---------- templates ----------

const TAURI_RUST_FRONTENDS = ["yew", "leptos", "sycamore"];
const TAURI_TS_FRONTENDS = ["vanilla", "vue", "svelte", "react", "solid", "preact"];

const tauri: Template = {
  id: "tauri",
  name: "Tauri v2",
  blurb: "Desktop and mobile app with a Rust core and a web frontend",
  group: "Desktop & mobile",
  icon: "AppWindow",
  kind: "Tauri",
  frameworkLabel: "Frontend",
  frameworks: [
    { value: "react", label: "React" },
    { value: "vue", label: "Vue" },
    { value: "svelte", label: "Svelte" },
    { value: "solid", label: "Solid" },
    { value: "preact", label: "Preact" },
    { value: "vanilla", label: "Vanilla" },
    { value: "angular", label: "Angular" },
    { value: "leptos", label: "Leptos (Rust)" },
    { value: "yew", label: "Yew (Rust)" },
    { value: "sycamore", label: "Sycamore (Rust)" },
  ],
  languages: LANG_TS_JS,
  languageApplies: (c) => TAURI_TS_FRONTENDS.includes(c.framework),
  options: [],
  identifier: { label: "Bundle identifier", placeholder: (c) => `com.example.${slugify(c.name).replace(/[^a-z0-9]/g, "") || "app"}` },
  usesPm: true,
  depGroups: [
    ...NODE_DEPS,
    { id: "crates", label: "Rust crates (src-tauri)", placeholder: "serde_json anyhow" },
  ],
  icons: ["tauri"],
  tools: (c) => [...nodeTools(c), { ...RUST_TOOL, required: false }],
  build(c) {
    const rust = TAURI_RUST_FRONTENDS.includes(c.framework);
    const template = TAURI_TS_FRONTENDS.includes(c.framework) && c.language !== "js" ? `${c.framework}-ts` : c.framework;
    const steps: Step[] = [
      dlx(
        c.pm,
        "create-tauri-app@latest",
        [c.folder, "-m", rust ? "cargo" : c.pm, "-t", template, "--identifier", c.identifier, "--tauri-version", "2", "-y"],
        "Create the Tauri app",
        "src-tauri/tauri.conf.json",
      ),
      {
        kind: "jsonSet",
        label: "Set version and name in tauri.conf.json",
        file: "src-tauri/tauri.conf.json",
        sets: [
          { path: "version", value: c.version },
          { path: "productName", value: c.name.trim() },
        ],
      },
      cargoVersion(c, "src-tauri/Cargo.toml"),
    ];
    if (!rust) {
      steps.push(packageJson(c));
      steps.push(...nodeDeps(c));
    }
    const crates = parseDeps(c.deps.crates);
    if (crates.length) steps.push(run(`Add crates ${crates.join(", ")}`, "cargo", ["add", ...crates], "project/src-tauri"));
    return steps;
  },
  commands: (c) => (TAURI_RUST_FRONTENDS.includes(c.framework) ? [] : [{ label: "Tauri dev", command: `${c.pm} tauri dev` }]),
};

function viteTemplate(id: string, name: string, kind: string, icon: string, blurb: string, base: string, extra?: Partial<Template>): Template {
  return {
    id,
    name,
    blurb,
    group: "Web",
    icon,
    kind,
    languages: LANG_TS_JS,
    options: [],
    usesPm: true,
    depGroups: NODE_DEPS,
    icons: ["web"],
    tools: nodeTools,
    build(c) {
      const compiler = on(c, "compiler");
      const template = `${base}${compiler ? "-compiler" : ""}${c.language === "ts" ? "-ts" : ""}`;
      const steps: Step[] = [
        dlx(c.pm, "create-vite@latest", [c.folder, "--template", template, "--no-interactive"], `Create the ${name} app (Vite)`),
        packageJson(c),
      ];
      if (c.icon) {
        steps.push({
          kind: "replace",
          label: "Point index.html at the new favicon",
          file: "index.html",
          pattern: String.raw`<link rel="icon"[^>]*href="/(?:vite|favicon)\.svg"[^>]*/?>`,
          replacement: `<link rel="icon" href="/favicon.ico" sizes="any" />\n    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
          optional: true,
        });
      }
      steps.push(...nodeDeps(c));
      return steps;
    },
    commands: (c) => [{ label: "Dev server", command: `${c.pm} run dev` }],
    ...extra,
  };
}

const react = viteTemplate("react", "React", "React", "Atom", "Single-page app with Vite", "react", {
  options: [{ id: "compiler", label: "Enable React Compiler", type: "toggle", default: false }],
});
const vue = viteTemplate("vue", "Vue", "Vue", "Layers", "Single-page app with Vite", "vue");

const nextjs: Template = {
  id: "nextjs",
  name: "Next.js",
  blurb: "Full-stack React framework",
  group: "Web",
  icon: "Triangle",
  kind: "Next.js",
  languages: LANG_TS_JS,
  options: [
    {
      id: "router",
      label: "Router",
      type: "select",
      choices: [
        { value: "app", label: "App Router" },
        { value: "pages", label: "Pages Router" },
      ],
      default: "app",
    },
    { id: "tailwind", label: "Tailwind CSS", type: "toggle", default: true },
    { id: "eslint", label: "ESLint", type: "toggle", default: true },
    { id: "src", label: "Use a src/ directory", type: "toggle", default: false },
  ],
  usesPm: true,
  depGroups: NODE_DEPS,
  icons: ["web"],
  tools: nodeTools,
  build(c) {
    const args = [
      c.folder,
      c.language === "ts" ? "--ts" : "--js",
      on(c, "tailwind") ? "--tailwind" : "--no-tailwind",
      on(c, "eslint") ? "--eslint" : "--no-eslint",
      sel(c, "router") === "pages" ? "--no-app" : "--app",
      on(c, "src") ? "--src-dir" : "--no-src-dir",
      "--import-alias",
      "@/*",
      `--use-${c.pm}`,
      "--skip-install",
      "--disable-git",
      "--yes",
    ];
    return [dlx(c.pm, "create-next-app@latest", args, "Create the Next.js app"), packageJson(c), ...nodeDeps(c)];
  },
  commands: (c) => [{ label: "Dev server", command: `${c.pm} run dev` }],
};

const astro: Template = {
  id: "astro",
  name: "Astro",
  blurb: "Content-focused websites with islands of UI",
  group: "Web",
  icon: "Rocket",
  kind: "Astro",
  frameworkLabel: "UI framework",
  frameworks: [
    { value: "none", label: "None" },
    { value: "react", label: "React" },
    { value: "vue", label: "Vue" },
    { value: "svelte", label: "Svelte" },
    { value: "solid-js", label: "Solid" },
    { value: "preact", label: "Preact" },
  ],
  options: [
    {
      id: "starter",
      label: "Starter",
      type: "select",
      choices: [
        { value: "basics", label: "Basics" },
        { value: "minimal", label: "Minimal" },
        { value: "blog", label: "Blog" },
      ],
      default: "basics",
    },
    { id: "tailwind", label: "Tailwind CSS", type: "toggle", default: false },
  ],
  usesPm: true,
  depGroups: NODE_DEPS,
  icons: ["web"],
  tools: nodeTools,
  build(c) {
    const steps: Step[] = [
      dlx(c.pm, "create-astro@latest", [c.folder, "--template", sel(c, "starter"), "--no-install", "--no-git", "--yes", "--skip-houston"], "Create the Astro site"),
      packageJson(c),
      install(c.pm),
    ];
    const integrations = [c.framework !== "none" ? c.framework : "", on(c, "tailwind") ? "tailwind" : ""].filter(Boolean);
    if (integrations.length) steps.push(exec(c.pm, ["astro", "add", ...integrations, "--yes"], `Add ${integrations.join(" + ")}`));
    const deps = parseDeps(c.deps.deps);
    const dev = parseDeps(c.deps.dev);
    if (deps.length) steps.push(add(c.pm, deps, false, `Add ${deps.join(", ")}`));
    if (dev.length) steps.push(add(c.pm, dev, true, `Add ${dev.join(", ")} (dev)`));
    return steps;
  },
  commands: (c) => [{ label: "Dev server", command: `${c.pm} run dev` }],
};

const sveltekit: Template = {
  id: "sveltekit",
  name: "SvelteKit",
  blurb: "Full-stack Svelte framework",
  group: "Web",
  icon: "Flame",
  kind: "SvelteKit",
  languages: [
    { value: "ts", label: "TypeScript" },
    { value: "js", label: "JavaScript (JSDoc)" },
  ],
  options: [
    { id: "tailwind", label: "Tailwind CSS", type: "toggle", default: false },
    { id: "eslint", label: "ESLint", type: "toggle", default: true },
    { id: "prettier", label: "Prettier", type: "toggle", default: true },
    { id: "vitest", label: "Vitest", type: "toggle", default: false },
  ],
  usesPm: true,
  depGroups: NODE_DEPS,
  icons: ["web"],
  tools: nodeTools,
  build(c) {
    // Add-ons that ask follow-up questions need their answers on the command line.
    const addons = [on(c, "tailwind") && "tailwindcss=plugins:none", on(c, "eslint") && "eslint", on(c, "prettier") && "prettier", on(c, "vitest") && "vitest=usages:unit,component"].filter(Boolean) as string[];
    const args = [
      "create",
      c.folder,
      "--template",
      "minimal",
      "--types",
      c.language === "ts" ? "ts" : "jsdoc",
      ...(addons.length ? ["--add", ...addons] : ["--no-add-ons"]),
      "--no-install",
    ];
    return [dlx(c.pm, "sv@latest", args, "Create the SvelteKit app"), packageJson(c), ...nodeDeps(c)];
  },
  commands: (c) => [{ label: "Dev server", command: `${c.pm} run dev` }],
};

const expo: Template = {
  id: "expo",
  name: "Expo (React Native)",
  blurb: "iOS and Android apps with React Native",
  group: "Desktop & mobile",
  icon: "Smartphone",
  kind: "Expo",
  options: [
    {
      id: "starter",
      label: "Starter",
      type: "select",
      choices: [
        { value: "default", label: "Default (Expo Router, TypeScript)" },
        { value: "tabs", label: "Tabs (Expo Router)" },
        { value: "blank-typescript", label: "Blank (TypeScript)" },
        { value: "blank", label: "Blank (JavaScript)" },
      ],
      default: "default",
    },
  ],
  identifier: { label: "Bundle identifier / package", placeholder: (c) => `com.example.${slugify(c.name).replace(/[^a-z0-9]/g, "") || "app"}` },
  usesPm: true,
  depGroups: [
    { id: "deps", label: "Extra dependencies", placeholder: "zustand" },
    { id: "dev", label: "Extra dev dependencies", placeholder: "prettier" },
  ],
  icons: ["expo"],
  tools: nodeTools,
  build(c) {
    return [
      dlx(c.pm, "create-expo-app@latest", [c.folder, "--template", sel(c, "starter"), "--no-install", "--yes"], "Create the Expo app"),
      {
        kind: "jsonSet",
        label: "Set name, version and identifiers in app.json",
        file: "app.json",
        sets: [
          { path: "expo.name", value: c.name.trim() },
          { path: "expo.version", value: c.version },
          { path: "expo.ios.bundleIdentifier", value: c.identifier },
          { path: "expo.android.package", value: c.identifier },
        ],
      },
      packageJson(c),
      ...nodeDeps(c),
    ];
  },
  commands: (c) => [{ label: "Start Expo", command: `${c.pm === "npm" ? "npx" : c.pm === "bun" ? "bunx" : c.pm} expo start` }],
};

// ---------- SwiftUI ----------

function swiftFiles(c: InitConfig, app: string): Step[] {
  const platform = sel(c, "platform");
  const ios = platform !== "macos";
  const mac = platform !== "ios";
  const hasIcon = !!c.icon;
  const f = (path: string, contents: string): Step => ({ kind: "write", label: `Write ${path}`, path, contents });

  const icon: Record<string, string>[] = [];
  if (ios) icon.push({ ...(hasIcon ? { filename: "icon-ios.png" } : {}), idiom: "universal", platform: "ios", size: "1024x1024" });
  if (mac) {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        icon.push({ ...(hasIcon ? { filename: `icon-mac-${size}@${scale}x.png` } : {}), idiom: "mac", scale: `${scale}x`, size: `${size}x${size}` });
      }
    }
  }
  const info = { author: "xcode", version: 1 };

  // "URL", "URL@version" or "URL@version#Product" (the product defaults to the repository name).
  const packages = parseDeps(c.deps.packages).map((spec) => {
    const [rest, product] = spec.split("#");
    const [url, from] = rest.split("@");
    const name = url.replace(/\.git$/, "").split("/").pop() ?? "package";
    return { name, url, from, product: product || name };
  });
  const pkgYaml = packages.length
    ? "packages:\n" + packages.map((p) => `  ${p.name}:\n    url: ${p.url}\n    ${p.from ? `from: ${p.from}` : "branch: main"}\n`).join("")
    : "";
  const depYaml = packages.length ? "    dependencies:\n" + packages.map((p) => `      - package: ${p.name}\n        product: ${p.product}\n`).join("") : "";

  const yml = `name: ${app}
options:
  bundleIdPrefix: ${c.identifier.split(".").slice(0, -1).join(".") || "com.example"}
  deploymentTarget:
${ios ? '    iOS: "17.0"\n' : ""}${mac ? '    macOS: "14.0"\n' : ""}  createIntermediateGroups: true
${pkgYaml}settings:
  base:
    SWIFT_VERSION: "5.0"
targets:
  ${app}:
    type: application
    platform: ${ios ? "iOS" : "macOS"}
${ios && mac ? "    supportedDestinations: [iOS, macOS]\n" : ""}    sources:
      - ${app}
${depYaml}    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${c.identifier}
        PRODUCT_NAME: ${c.name.trim().replace(/[:#]/g, "")}
        MARKETING_VERSION: "${c.version}"
        CURRENT_PROJECT_VERSION: "1"
        GENERATE_INFOPLIST_FILE: YES
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor
${ios ? "        INFOPLIST_KEY_UILaunchScreen_Generation: YES\n        INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES\n        TARGETED_DEVICE_FAMILY: \"1,2\"\n" : ""}${mac ? "        INFOPLIST_KEY_NSHumanReadableCopyright: \"\"\n" : ""}`;

  const swiftApp = `import SwiftUI

@main
struct ${app}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`;
  const content = `import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "sparkles")
                .imageScale(.large)
                .foregroundStyle(.tint)
            Text("Hello, ${c.name.trim().replace(/["\\]/g, "")}!")
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
`;
  return [
    f("project.yml", yml),
    f(`${app}/${app}App.swift`, swiftApp),
    f(`${app}/ContentView.swift`, content),
    f(`${app}/Assets.xcassets/Contents.json`, JSON.stringify({ info }, null, 2) + "\n"),
    f(`${app}/Assets.xcassets/AccentColor.colorset/Contents.json`, JSON.stringify({ colors: [{ idiom: "universal" }], info }, null, 2) + "\n"),
    f(`${app}/Assets.xcassets/AppIcon.appiconset/Contents.json`, JSON.stringify({ images: icon, info }, null, 2) + "\n"),
    f(".gitignore", ".DS_Store\nxcuserdata/\nDerivedData/\n.build/\n*.xcuserstate\n"),
  ];
}

const swiftui: Template = {
  id: "swiftui",
  name: "SwiftUI",
  blurb: "Native Apple app for iOS and macOS (Xcode project via XcodeGen)",
  group: "Apple",
  icon: "Apple",
  kind: "Swift",
  options: [
    {
      id: "platform",
      label: "Platforms",
      type: "select",
      choices: [
        { value: "ios", label: "iOS" },
        { value: "macos", label: "macOS" },
        { value: "both", label: "iOS + macOS" },
      ],
      default: "ios",
    },
  ],
  identifier: { label: "Bundle identifier", placeholder: (c) => `com.example.${pascal(c.name).toLowerCase()}` },
  usesPm: false,
  depGroups: [{ id: "packages", label: "Swift packages (URL@version#Product)", placeholder: "https://github.com/apple/swift-collections@1.1.0#Collections" }],
  icons: ["apple"],
  tools: () => [{ program: "xcodegen", hint: "brew install xcodegen", required: true }],
  build(c) {
    const app = pascal(c.name);
    return [...swiftFiles(c, app), run("Generate the Xcode project", "xcodegen", ["generate"], "project")];
  },
  commands: (c) => {
    const app = pascal(c.name);
    const cmds = [{ label: "Open in Xcode", command: `open ${app}.xcodeproj` }];
    if (sel(c, "platform") !== "ios") cmds.push({ label: "Build (macOS)", command: `xcodebuild -scheme ${app} -destination 'platform=macOS' build` });
    return cmds;
  },
};

// ---------- languages ----------

const rust: Template = {
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

const python: Template = {
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

const go: Template = {
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

const nodeTs: Template = {
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

const flutter: Template = {
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

export const TEMPLATES: Template[] = [tauri, react, nextjs, astro, vue, sveltekit, expo, flutter, swiftui, rust, python, go, nodeTs];

export const GROUPS: Template["group"][] = ["Desktop & mobile", "Web", "Apple", "Languages"];

export const findTemplate = (id: string) => TEMPLATES.find((t) => t.id === id);

// ---------- config + plan ----------

export function defaultConfig(t: Template, parent: string, pm: Pm = "npm"): InitConfig {
  const options: InitConfig["options"] = {};
  for (const o of t.options) options[o.id] = o.default;
  const c: InitConfig = {
    name: "",
    folder: "",
    parent,
    version: "0.1.0",
    description: "",
    identifier: "",
    framework: t.frameworks?.[0]?.value ?? "",
    language: t.languages?.[0]?.value ?? "",
    options,
    pm,
    deps: {},
    icon: null,
    git: true,
    branch: "main",
    github: "",
  };
  return c;
}

/** The answers with derived values (folder name, identifier) filled in. */
export function resolved(t: Template, c: InitConfig): InitConfig {
  const folder = c.folder.trim() || slugify(c.name);
  const base = { ...c, folder };
  const identifier = c.identifier.trim() || t.identifier?.placeholder(base) || "";
  return { ...base, identifier, version: c.version.trim() || "0.1.0" };
}

export function validate(t: Template, raw: InitConfig): string | null {
  const c = resolved(t, raw);
  if (!c.name.trim()) return "Give the project a name.";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(c.folder)) return "The folder name can only use lowercase letters, numbers, dots, dashes and underscores.";
  if (!c.parent.trim()) return "Choose where to create the project.";
  if (!t.noVersion && !SEMVER.test(c.version)) return "The version should look like 1.0.0.";
  if (t.identifier && t.id !== "go" && t.id !== "flutter" && !REVERSE_DNS.test(c.identifier)) return `${t.identifier.label} should look like com.example.app.`;
  if (t.id === "flutter" && !REVERSE_DNS.test(c.identifier)) return "The organization should look like com.example.";
  if (t.id === "go" && !c.identifier.trim()) return "Enter a module path.";
  if (c.github && !c.git) return "Turn on git to create a GitHub repository.";
  return null;
}

export function requiredTools(t: Template, raw: InitConfig): Tool[] {
  const c = resolved(t, raw);
  const tools = [...t.tools(c)];
  if (c.git) tools.push({ program: "git", hint: "Install Git from git-scm.com", required: true });
  if (c.github) tools.push({ program: "gh", hint: "brew install gh, then gh auth login", required: true });
  const seen = new Set<string>();
  return tools.filter((x) => !seen.has(x.program) && seen.add(x.program));
}

export function buildPlan(t: Template, raw: InitConfig): Step[] {
  const c = resolved(t, raw);
  const steps = t.build(c);
  if (c.icon && t.icons.length) {
    steps.push({ kind: "icons", label: "Generate app icons for every platform", source: c.icon, targets: t.icons });
  }
  if (c.git) {
    steps.push({ kind: "git", label: "Create the git repository", message: `Initial commit: ${c.name.trim()}`, branch: c.branch.trim() || "main", commit: true });
    if (c.github) {
      steps.push(run("Create the GitHub repository", "gh", ["repo", "create", c.folder, `--${c.github}`, "--source", ".", "--remote", "origin", "--push"], "project", true));
    }
  }
  return steps;
}

/** Commands to register for the new project, on top of the ones BluePhoenix detects. */
export function extraCommands(t: Template, raw: InitConfig) {
  return t.commands?.(resolved(t, raw)) ?? [];
}
