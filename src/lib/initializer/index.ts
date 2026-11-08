// Templates for the "New project" wizard. A template turns the wizard's answers into a plan: an
// ordered list of steps (commands, small file edits, icons, git) that the backend runs.
//
// types.ts holds the shapes, helpers.ts the shared building blocks, templates/ one file per family.

export * from "./types";
export { slugify, pascal, snake, parseDeps, SEMVER, REVERSE_DNS } from "./helpers";
import type { Pm, Step, Tool, InitConfig, Template } from "./types";
import { slugify, SEMVER, REVERSE_DNS, run } from "./helpers";
import { tauri } from "./templates/tauri";
import { react, vue, nextjs, astro, sveltekit, expo } from "./templates/javascript";
import { swiftui } from "./templates/swiftui";
import { rust, python, go, nodeTs, flutter } from "./templates/languages";

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
