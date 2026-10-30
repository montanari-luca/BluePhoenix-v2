import type { Automation, AutomationTrigger, ProjectSummary } from "./types";

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  launch: "When launching BluePhoenix",
  quit: "When quitting BluePhoenix",
  schedule: "On a schedule (while BluePhoenix is open)",
  commit: "After a commit made in BluePhoenix",
  manual: "Manual run only",
};

export const TRIGGER_SHORT: Record<AutomationTrigger, string> = {
  launch: "On launch",
  quit: "On quit",
  schedule: "Scheduled",
  commit: "After commit",
  manual: "Manual",
};

export function newAutomation(): Automation {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    enabled: true,
    trigger: "launch",
    runAt: null,
    repeatHours: null,
    notify: "none",
    notifyBeforeMin: null,
    targetMode: "selected",
    projectIds: [],
    kindFilter: null,
    idleHours: null,
    requireCleanGit: false,
    requireGitRepo: false,
    commands: "",
    sort: 0,
  };
}

// ---------- templates ----------

export interface AutomationTemplate {
  id: string;
  fields: Partial<Automation> & Pick<Automation, "name" | "description" | "commands">;
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "cargo-clean",
    fields: {
      name: "Cargo clean",
      description: "Every 48h, clean every cargo build on non-active tauri projects",
      trigger: "launch",
      repeatHours: 48,
      targetMode: "all",
      kindFilter: "Tauri",
      idleHours: 48,
      commands: "cd src-tauri && cargo clean",
    },
  },
  {
    id: "git-pull",
    fields: {
      name: "Git pull",
      description: "Pull all missing changes when safe",
      trigger: "launch",
      targetMode: "all",
      requireGitRepo: true,
      commands: '[ -z "$(git status --porcelain)" ] && git pull || echo "Local changes detected. Aborting pull."',
    },
  },
  {
    id: "git-fetch-all",
    fields: {
      name: "Git fetch all",
      description: "Every 6h, fetch every remote so you can see what is new without changing files",
      trigger: "launch",
      repeatHours: 6,
      targetMode: "all",
      requireGitRepo: true,
      commands: "git fetch --all --prune",
    },
  },
  {
    id: "rust-target-cleanup",
    fields: {
      name: "Rust target cleanup",
      description: "Every 48h, clean the build output of Rust projects you are not working on",
      trigger: "launch",
      repeatHours: 48,
      targetMode: "all",
      kindFilter: "Rust",
      idleHours: 48,
      commands: "cargo clean",
    },
  },
  {
    id: "node-cleanup",
    fields: {
      name: "Node cleanup",
      description: "Weekly, remove node_modules from Node projects not edited for 14 days (reinstall when you return)",
      trigger: "launch",
      repeatHours: 168,
      targetMode: "all",
      kindFilter: "Node.js",
      idleHours: 336,
      commands: "rm -rf node_modules",
    },
  },
  {
    id: "package-audit",
    fields: {
      name: "Package audit",
      description: "At every launch, install dependencies and audit them with the project's package manager (auto-detected)",
      trigger: "launch",
      targetMode: "all",
      commands: [
        'PM="" # leave empty to auto-detect from the lockfile, or set npm, pnpm, yarn or bun',
        '[ -f package.json ] || { echo "No package.json, skipping."; exit 0; }',
        'if [ -z "$PM" ]; then',
        "  if [ -f pnpm-lock.yaml ]; then PM=pnpm",
        "  elif [ -f yarn.lock ]; then PM=yarn",
        "  elif [ -f bun.lock ] || [ -f bun.lockb ]; then PM=bun",
        "  else PM=npm",
        "  fi",
        "fi",
        'echo "Using $PM"',
        'if [ "$PM" = yarn ] && [ -f .yarnrc.yml ]; then',
        "  yarn install && yarn npm audit",
        "else",
        '  $PM install && $PM audit',
        "fi",
      ].join("\n"),
    },
  },
];

export function fromTemplate(t: AutomationTemplate): Automation {
  return { ...newAutomation(), ...t.fields };
}

// ---------- validation (mirrors the checks in src-tauri/src/automations.rs) ----------

export function validateAutomation(a: Automation): string | null {
  if (!a.name.trim()) return "Give the automation a name";
  if (!a.commands.trim()) return "Add at least one command to run";
  if (a.trigger === "schedule" && a.runAt == null && a.repeatHours == null) {
    return "A scheduled automation needs a date and time or a repeat interval";
  }
  if (a.notify === "before") {
    if (a.trigger !== "schedule") return "“Before” alerts only work with scheduled automations";
    if (!a.notifyBeforeMin || a.notifyBeforeMin <= 0) return "Set how many minutes before the run to alert";
  }
  if (a.repeatHours != null && a.repeatHours <= 0) return "Repeat interval must be at least 1 hour";
  if (a.idleHours != null && a.idleHours <= 0) return "The not-edited window must be at least 1 hour";
  if (a.targetMode === "selected" && a.projectIds.length === 0) return "Pick at least one project";
  return null;
}

// ---------- display helpers ----------

export function formatHours(h: number): string {
  if (h >= 24 && h % 24 === 0) {
    const d = h / 24;
    return d === 1 ? "1 day" : `${d} days`;
  }
  return `${h}h`;
}

export type HourUnit = "hours" | "days";

export function splitHours(h: number): { n: number; unit: HourUnit } {
  return h >= 24 && h % 24 === 0 ? { n: h / 24, unit: "days" } : { n: h, unit: "hours" };
}

export function joinHours(n: number, unit: HourUnit): number {
  return unit === "days" ? n * 24 : n;
}

/** Short description of when it runs, e.g. "On launch · every 48h". */
export function describeWhen(a: Automation): string {
  const parts: string[] = [TRIGGER_SHORT[a.trigger]];
  if (a.trigger !== "manual") {
    if (a.repeatHours) parts.push(`every ${formatHours(a.repeatHours)}`);
    else if (a.runAt) parts.push("once");
    else parts.push("every time");
  }
  return parts.join(" · ");
}

export function describeTargets(a: Automation, projects: Pick<ProjectSummary, "id" | "name">[]): string {
  if (a.targetMode === "all") return a.kindFilter ? `All ${a.kindFilter} projects` : "All projects";
  const names = a.projectIds.map((id) => projects.find((p) => p.id === id)?.name).filter((n): n is string => !!n);
  if (names.length === 0) return "No projects found";
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

export function requisiteChips(a: Automation): string[] {
  const chips: string[] = [];
  if (a.idleHours) chips.push(`Not edited for ${formatHours(a.idleHours)}`);
  if (a.requireCleanGit) chips.push("Clean git tree");
  if (a.requireGitRepo) chips.push("Git repo");
  return chips;
}

// ---------- <input type="datetime-local"> ----------

const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalInput(ts: number | null): string {
  if (ts == null) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}
