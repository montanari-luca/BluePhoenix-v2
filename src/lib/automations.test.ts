import { describe, expect, it } from "vitest";
import {
  AUTOMATION_TEMPLATES,
  describeTargets,
  describeWhen,
  formatHours,
  fromLocalInput,
  fromTemplate,
  joinHours,
  newAutomation,
  requisiteChips,
  splitHours,
  toLocalInput,
  validateAutomation,
} from "./automations";

describe("templates", () => {
  it("are valid once a project is picked, and have unique ids", () => {
    expect(new Set(AUTOMATION_TEMPLATES.map((t) => t.id)).size).toBe(AUTOMATION_TEMPLATES.length);
    for (const t of AUTOMATION_TEMPLATES) {
      const a = fromTemplate(t);
      expect(validateAutomation(a), t.id).toBeNull();
    }
  });

  it("fromTemplate gives each automation a fresh id", () => {
    const t = AUTOMATION_TEMPLATES[0];
    expect(fromTemplate(t).id).not.toBe(fromTemplate(t).id);
  });

  it("Cargo clean matches the brief", () => {
    const a = fromTemplate(AUTOMATION_TEMPLATES.find((t) => t.id === "cargo-clean")!);
    expect(a).toMatchObject({ trigger: "launch", repeatHours: 48, kindFilter: "Tauri", idleHours: 48, commands: "cd src-tauri && cargo clean" });
  });

  it("Package audit runs on every launch and detects the package manager", () => {
    const a = fromTemplate(AUTOMATION_TEMPLATES.find((t) => t.id === "package-audit")!);
    expect(a).toMatchObject({ trigger: "launch", repeatHours: null, targetMode: "all", kindFilter: null });
    for (const pm of ["pnpm-lock.yaml", "yarn.lock", "bun.lock"]) expect(a.commands).toContain(pm);
    expect(a.commands).toContain('$PM install && $PM audit');
  });

  it("Git pull runs every launch on repos", () => {
    const a = fromTemplate(AUTOMATION_TEMPLATES.find((t) => t.id === "git-pull")!);
    expect(a).toMatchObject({ trigger: "launch", repeatHours: null, targetMode: "all", requireGitRepo: true });
  });
});

describe("validateAutomation", () => {
  const ok = { ...newAutomation(), name: "x", commands: "ls", projectIds: ["p"] };

  it("accepts a minimal automation", () => {
    expect(validateAutomation(ok)).toBeNull();
  });

  it("rejects missing basics", () => {
    expect(validateAutomation({ ...ok, name: " " })).toMatch(/name/);
    expect(validateAutomation({ ...ok, commands: "" })).toMatch(/command/);
    expect(validateAutomation({ ...ok, projectIds: [] })).toMatch(/project/);
  });

  it("rejects schedules that can never fire and misplaced alerts", () => {
    expect(validateAutomation({ ...ok, trigger: "schedule" })).toMatch(/scheduled/);
    expect(validateAutomation({ ...ok, trigger: "schedule", repeatHours: 1 })).toBeNull();
    expect(validateAutomation({ ...ok, notify: "before", notifyBeforeMin: 5 })).toMatch(/scheduled/);
    expect(validateAutomation({ ...ok, trigger: "schedule", repeatHours: 1, notify: "before" })).toMatch(/minutes/);
  });
});

describe("hours", () => {
  it("formats and splits whole days", () => {
    expect(formatHours(6)).toBe("6h");
    expect(formatHours(48)).toBe("2 days");
    expect(formatHours(24)).toBe("1 day");
    expect(formatHours(36)).toBe("36h");
    expect(splitHours(48)).toEqual({ n: 2, unit: "days" });
    expect(splitHours(36)).toEqual({ n: 36, unit: "hours" });
    expect(joinHours(2, "days")).toBe(48);
  });
});

describe("descriptions", () => {
  const base = newAutomation();

  it("describeWhen", () => {
    expect(describeWhen({ ...base, trigger: "launch", repeatHours: 48 })).toBe("On launch · every 2 days");
    expect(describeWhen({ ...base, trigger: "launch" })).toBe("On launch · every time");
    expect(describeWhen({ ...base, trigger: "schedule", runAt: 1 })).toBe("Scheduled · once");
    expect(describeWhen({ ...base, trigger: "manual" })).toBe("Manual");
  });

  it("describeTargets", () => {
    const projects = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "c", name: "Gamma" }];
    expect(describeTargets({ ...base, targetMode: "all" }, projects)).toBe("All projects");
    expect(describeTargets({ ...base, targetMode: "all", kindFilter: "Tauri" }, projects)).toBe("All Tauri projects");
    expect(describeTargets({ ...base, projectIds: ["a"] }, projects)).toBe("Alpha");
    expect(describeTargets({ ...base, projectIds: ["a", "b", "c"] }, projects)).toBe("Alpha, Beta +1");
    expect(describeTargets({ ...base, projectIds: ["gone"] }, projects)).toBe("No projects found");
  });

  it("requisiteChips", () => {
    expect(requisiteChips({ ...base, idleHours: 48, requireCleanGit: true })).toEqual(["Not edited for 2 days", "Clean git tree"]);
    expect(requisiteChips(base)).toEqual([]);
  });
});

describe("datetime-local", () => {
  it("round-trips to the minute", () => {
    const t = new Date(2026, 9, 30, 14, 5).getTime();
    expect(toLocalInput(t)).toBe("2026-10-30T14:05");
    expect(fromLocalInput(toLocalInput(t))).toBe(t);
    expect(fromLocalInput("")).toBeNull();
    expect(toLocalInput(null)).toBe("");
  });
});
