// The user's own templates: a plan saved from the wizard with the project's name, folder and
// identifier replaced by {{placeholders}}, turned back into a regular Template when used.

import type { CustomTemplate } from "../types";
import { buildPlan, extraCommands, requiredTools, resolved } from "./index";
import type { InitConfig, Step, Template } from "./types";

type Tokens = Partial<Record<"name" | "folder" | "identifier" | "description" | "version", string>>;

const TOKEN = /\{\{(name|folder|identifier|description|version)\}\}/g;

/** Applies `fn` to every string inside a JSON-like value. */
function mapStrings<T>(v: T, fn: (s: string) => string): T {
  if (typeof v === "string") return fn(v) as T;
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)])) as T;
  return v;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces the answers with placeholders. Short values (under 3 characters) are left alone so
 * they cannot hit unrelated text; the version is only replaced where it is the whole string. */
export function tokenize<T>(v: T, t: Tokens): T {
  const pairs = (["identifier", "description", "folder", "name"] as const)
    .map((k) => [k, t[k]?.trim() ?? ""] as const)
    .filter(([, val]) => val.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  return mapStrings(v, (s) => {
    if (t.version && s === t.version) return "{{version}}";
    let out = s;
    for (const [k, val] of pairs) out = out.replace(new RegExp(escape(val), "g"), `{{${k}}}`);
    return out;
  });
}

export function detokenize<T>(v: T, t: Tokens): T {
  return mapStrings(v, (s) => s.replace(TOKEN, (_, k: keyof Tokens) => t[k] ?? ""));
}

const tokensOf = (c: InitConfig): Tokens => ({
  name: c.name.trim(),
  folder: c.folder,
  identifier: c.identifier,
  description: c.description.trim(),
  version: c.version,
});

const uses = (v: unknown, token: string) => JSON.stringify(v).includes(`{{${token}}}`);

/** What to save for a configured wizard run: its plan without the icon and git steps (the wizard
 * adds those again from the new project's answers). */
export function templateBody(t: Template, raw: InitConfig): CustomTemplate["body"] {
  const c = resolved(t, raw);
  const steps = buildPlan(t, raw).filter(
    (s) => s.kind !== "icons" && s.kind !== "git" && !(s.kind === "run" && s.program === "gh" && s.args[0] === "repo"),
  );
  const tools = requiredTools(t, raw)
    .map((x) => x.program)
    .filter((p) => p !== "git" && p !== "gh");
  return {
    steps: tokenize(steps, tokensOf(c)),
    tools,
    commands: tokenize(extraCommands(t, raw), tokensOf(c)),
    icons: t.icons,
  };
}

/** A saved template as a wizard Template. */
export function customTemplate(ct: CustomTemplate): Template {
  const body = ct.body;
  return {
    id: `custom:${ct.id}`,
    name: ct.name,
    blurb: ct.blurb || "Your template",
    group: "My templates",
    icon: ct.icon || "Bookmark",
    kind: ct.kind || "Other",
    options: [],
    usesPm: false,
    depGroups: [],
    icons: body.icons ?? [],
    noVersion: !uses(body.steps, "version"),
    identifier: uses(body.steps, "identifier")
      ? { label: "Identifier", placeholder: (c) => `com.example.${c.folder.replace(/[^a-z0-9]/g, "")}` }
      : undefined,
    tools: () => (body.tools ?? []).map((program) => ({ program, hint: `This template runs ${program}.`, required: true })),
    build: (c) => detokenize(body.steps as Step[], tokensOf(c)),
    commands: (c) => detokenize(body.commands ?? [], tokensOf(c)),
  };
}
