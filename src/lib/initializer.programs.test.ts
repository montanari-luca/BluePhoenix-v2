// Every built-in template must pass the backend's plan validation (validate_plan in
// src-tauri/src/initializer.rs): only allowlisted programs, and working folders inside the project.
import { describe, expect, it } from "vitest";
import allowlist from "../../src-tauri/init-programs.json";
import { TEMPLATES, buildPlan, defaultConfig, type InitConfig, type Pm, type Template } from "./initializer";

const { programs } = allowlist;
const PMS: Pm[] = ["npm", "pnpm", "yarn", "bun"];

/** Defaults, then each option value on its own, then every toggle flipped at once. */
function optionSets(t: Template): InitConfig["options"][] {
  const base = Object.fromEntries(t.options.map((o) => [o.id, o.default]));
  const sets = [base];
  for (const o of t.options) {
    const values = o.type === "toggle" ? [!o.default] : (o.choices ?? []).map((c) => c.value);
    for (const v of values) sets.push({ ...base, [o.id]: v });
  }
  sets.push(Object.fromEntries(t.options.map((o) => [o.id, o.type === "toggle" ? !o.default : o.default])));
  return sets;
}

function configs(t: Template): InitConfig[] {
  const out: InitConfig[] = [];
  const deps = Object.fromEntries(t.depGroups.map((g) => [g.id, g.placeholder]));
  for (const pm of t.usesPm ? PMS : (["npm"] as Pm[]))
    for (const framework of t.frameworks?.map((f) => f.value) ?? [""])
      for (const language of t.languages?.map((l) => l.value) ?? [""])
        for (const options of optionSets(t))
          out.push({ ...defaultConfig(t, "/work", pm), name: "Demo App", framework, language, options, deps, icon: "/i.png", github: "private" });
  return out;
}

/** Mirrors run_dir: `parent`, `project`, or a folder inside the project. */
const cwdOk = (cwd: string | undefined) => {
  if (cwd === undefined || cwd === "parent" || cwd === "project") return true;
  const rel = cwd.replace(/^project\//, "");
  return !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel) && rel.split(/[\\/]/).every((p) => p !== "..");
};

describe("template plans pass the backend allowlist", () => {
  for (const t of TEMPLATES) {
    it(t.id, () => {
      for (const c of configs(t)) {
        for (const step of buildPlan(t, c)) {
          if (step.kind !== "run") continue;
          expect(programs, `${t.id}: ${step.label}`).toContain(step.program);
          expect(cwdOk(step.cwd), `${t.id}: ${step.label} in ${step.cwd}`).toBe(true);
        }
      }
    });
  }
});
