// Bits shared by the New project wizard's steps.

import type { Pm, Step } from "../../lib/initializer";

export type Phase = "type" | "configure" | "run";
export type StepState = { status: "pending" | "running" | "ok" | "warn" | "error"; note?: string };

export const PM_ORDER: Pm[] = ["pnpm", "npm", "bun", "yarn"];

export const ICON_TARGET_NAMES: Record<string, string> = {
  tauri: "Windows, macOS and Linux",
  web: "favicons, Apple touch icon and web manifest sizes",
  apple: "iOS and macOS",
  android: "Android",
  expo: "Expo (iOS, Android, web)",
  windows: "Windows",
  "flutter-web": "web",
};

export function stepSummary(s: Step): string {
  if (s.kind === "run") return [s.program, ...s.args].join(" ");
  if (s.kind === "write") return `write ${s.path}`;
  if (s.kind === "jsonSet") return `edit ${s.file}`;
  if (s.kind === "replace") return `edit ${s.file}`;
  if (s.kind === "icons") return `icons → ${s.targets.join(", ")}`;
  return s.commit ? "git init + commit" : "git init";
}
