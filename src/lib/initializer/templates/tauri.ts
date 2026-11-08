// Tauri (desktop and mobile).
import type { Step, Template } from "../types";
import { slugify, parseDeps, run, dlx, nodeDeps, packageJson, cargoVersion, nodeTools, RUST_TOOL, LANG_TS_JS, NODE_DEPS } from "../helpers";

const TAURI_RUST_FRONTENDS = ["yew", "leptos", "sycamore"];
const TAURI_TS_FRONTENDS = ["vanilla", "vue", "svelte", "react", "solid", "preact"];

export const tauri: Template = {
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
