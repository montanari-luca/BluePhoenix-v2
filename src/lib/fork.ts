import type { ForkStatus, ForkSync } from "./types";

export const MIN_INTERVAL_MINUTES = 15;

export type IntervalUnit = "minutes" | "hours" | "days";

const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Ready-made check intervals, in minutes. Anything else is a custom interval. */
export const INTERVAL_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 720, label: "Every 12 hours" },
  { minutes: 1440, label: "Every 24 hours" },
  { minutes: 4320, label: "Every 3 days" },
  { minutes: 10080, label: "Every week" },
];

/** Splits minutes into the largest unit that divides them evenly, e.g. 90 -> 90 minutes, 2880 -> 2 days. */
export function splitInterval(minutes: number): { amount: number; unit: IntervalUnit } {
  const m = Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes) || 0);
  if (m % 1440 === 0) return { amount: m / 1440, unit: "days" };
  if (m % 60 === 0) return { amount: m / 60, unit: "hours" };
  return { amount: m, unit: "minutes" };
}

/** Inverse of `splitInterval`, never below the minimum interval. */
export function toMinutes(amount: number, unit: IntervalUnit): number {
  const n = Number.isFinite(amount) ? Math.round(amount * UNIT_MINUTES[unit]) : 0;
  return Math.max(MIN_INTERVAL_MINUTES, n);
}

export function describeInterval(minutes: number): string {
  const preset = INTERVAL_PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label.toLowerCase();
  const { amount, unit } = splitInterval(minutes);
  const name = amount === 1 ? unit.slice(0, -1) : unit;
  return amount === 1 ? `every ${name}` : `every ${amount} ${name}`;
}

export function blankFork(projectId: string): ForkSync {
  return {
    projectId,
    isFork: false,
    upstreamRemote: "upstream",
    upstreamUrl: null,
    upstreamBranch: null,
    autoCheck: false,
    intervalMinutes: 1440,
    autoPull: false,
    lastCheck: null,
    lastPull: null,
    status: null,
    behind: 0,
    ahead: 0,
    message: null,
  };
}

export function forkTone(status: ForkStatus | null | undefined): "ok" | "info" | "warn" | "bad" | "muted" {
  switch (status) {
    case "up-to-date":
    case "pulled":
      return "ok";
    case "safe":
      return "info";
    case "conflicting":
      return "bad";
    case "unknown":
      return "warn";
    case "error":
      return "bad";
    default:
      return "muted";
  }
}

export function forkLabel(f: Pick<ForkSync, "status" | "behind">): string {
  switch (f.status) {
    case "up-to-date":
      return "Up to date with upstream";
    case "pulled":
      return "Pulled upstream changes";
    case "safe":
      return `${f.behind} upstream commit${f.behind === 1 ? "" : "s"} · safe to pull`;
    case "conflicting":
      return `${f.behind} upstream commit${f.behind === 1 ? "" : "s"} · conflicting`;
    case "unknown":
      return `${f.behind} upstream commit${f.behind === 1 ? "" : "s"} · not tested`;
    case "error":
      return "Upstream check failed";
    default:
      return "Not checked yet";
  }
}
