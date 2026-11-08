// Small building blocks the templates share: names, steps, Node and Rust bits.

import type { Pm, Step, Choice, DepGroup, Tool, InitConfig } from "./types";

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

export const sel = (c: InitConfig, id: string) => String(c.options[id] ?? "");
export const on = (c: InitConfig, id: string) => c.options[id] === true;

export const run = (label: string, program: string, args: string[], cwd?: string, optional?: boolean): Step => ({
  kind: "run",
  label,
  program,
  args,
  cwd,
  optional,
});

/** Runs a package from the registry (npm create ...), like `npx` / `pnpm dlx`. */
export function dlx(pm: Pm, pkg: string, args: string[], label: string, expects = "package.json"): Step {
  // Some scaffolders exit 0 when they cannot ask a question, so check that they produced the project.
  const base = pm === "pnpm" ? run(label, "pnpm", ["dlx", pkg, ...args], "parent") : pm === "bun" ? run(label, "bunx", [pkg, ...args], "parent") : run(label, "npx", ["--yes", pkg, ...args], "parent");
  return { ...base, expects } as Step;
}

/** Runs a binary installed in the project (npx vite ...). */
export function exec(pm: Pm, args: string[], label: string): Step {
  if (pm === "pnpm") return run(label, "pnpm", ["exec", ...args], "project");
  if (pm === "bun") return run(label, "bunx", args, "project");
  return run(label, "npx", ["--yes", ...args], "project");
}

export const install = (pm: Pm): Step => run(`Install dependencies (${pm})`, pm, ["install"], "project");

export function add(pm: Pm, pkgs: string[], dev: boolean, label: string): Step {
  const flag = dev ? [pm === "bun" ? "-d" : "-D"] : [];
  return run(label, pm, [pm === "npm" ? "install" : "add", ...flag, ...pkgs], "project");
}

/** Install plus the user's extra packages, for any Node project. */
export function nodeDeps(c: InitConfig): Step[] {
  const steps: Step[] = [install(c.pm)];
  const deps = parseDeps(c.deps.deps);
  const dev = parseDeps(c.deps.dev);
  if (deps.length) steps.push(add(c.pm, deps, false, `Add ${deps.join(", ")}`));
  if (dev.length) steps.push(add(c.pm, dev, true, `Add ${dev.join(", ")} (dev)`));
  return steps;
}

export function packageJson(c: InitConfig, file = "package.json"): Step {
  const sets: { path: string; value: unknown }[] = [{ path: "version", value: c.version }];
  if (c.description.trim()) sets.push({ path: "description", value: c.description.trim() });
  return { kind: "jsonSet", label: "Set version and description", file, sets, optional: true };
}

export const cargoVersion = (c: InitConfig, file = "Cargo.toml"): Step => ({
  kind: "replace",
  label: "Set version in Cargo.toml",
  file,
  pattern: String.raw`(?m)^version\s*=\s*"[^"]*"`,
  replacement: `version = "${c.version}"`,
});

export const GITIGNORE_NODE = "node_modules\ndist\n.env\n.env.local\n.DS_Store\n*.log\n";

export const nodeTools = (c: InitConfig): Tool[] => {
  const hint = (p: string) => ({ pnpm: "npm i -g pnpm", npm: "Install Node.js from nodejs.org", yarn: "npm i -g yarn", bun: "Install from bun.sh" })[p] ?? "";
  const tools: Tool[] = [{ program: c.pm, hint: hint(c.pm), required: true }];
  if (c.pm === "bun") tools.push({ program: "bunx", hint: hint("bun"), required: true });
  if (c.pm === "npm" || c.pm === "yarn") tools.push({ program: "npx", hint: hint("npm"), required: true });
  return tools;
};

export const RUST_TOOL: Tool = { program: "cargo", hint: "Install Rust from rustup.rs", required: true };

export const LANG_TS_JS: Choice[] = [
  { value: "ts", label: "TypeScript" },
  { value: "js", label: "JavaScript" },
];

export const NODE_DEPS: DepGroup[] = [
  { id: "deps", label: "Extra dependencies", placeholder: "zustand react-router-dom" },
  { id: "dev", label: "Extra dev dependencies", placeholder: "vitest prettier" },
];
