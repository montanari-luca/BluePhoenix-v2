// Types shared by the New project wizard templates and the plan the backend runs.

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
