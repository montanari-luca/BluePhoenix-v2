export interface Project {
  id: string;
  name: string;
  description: string | null;
  path: string;
  kind: string;
  favorite: boolean;
  githubUrl: string | null;
  websiteUrl: string | null;
  defaultEditor: string | null;
  defaultTerminal: string | null;
  defaultCommandId: string | null;
  lastOpened: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary extends Project {
  totalMinutes: number;
  openTodos: number;
  doneTodos: number;
  lastActivity: number;
}

export interface Command {
  id: string;
  projectId: string;
  label: string;
  command: string;
  cwd: string | null;
  source: "auto" | "manual" | "ai";
  sort: number;
}

export interface TodoPage {
  id: string;
  projectId: string;
  title: string;
  markdown: string;
  sort: number;
}

export type TodoStatus = "todo" | "doing" | "done";

export interface Todo {
  id: string;
  projectId: string;
  pageId: string | null;
  title: string;
  notes: string;
  status: TodoStatus;
  priority: number; // 0 none, 1 low, 2 medium, 3 high
  due: number | null;
  aiPrompt: string | null;
  sort: number;
  createdAt: number;
  completedAt: number | null;
}

export interface TimeEntry {
  id: string;
  projectId: string;
  todoId: string | null;
  minutes: number;
  loggedAt: number;
  note: string | null;
}

export interface Change {
  path: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export type GitState = "no-repo" | "conflict" | "dirty" | "diverged" | "ahead" | "behind" | "no-upstream" | "clean";

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changes: Change[];
  stashCount: number;
  lastCommitTs: number | null;
  lastCommitSubject: string | null;
  remoteUrl: string | null;
  state: GitState;
}

export interface Branch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  lastCommitTs: number | null;
  subject: string;
}

export interface Commit {
  hash: string;
  short: string;
  author: string;
  ts: number;
  subject: string;
  body: string;
}

export interface AppInfo {
  id: string;
  name: string;
  installed: boolean;
}

export interface DetectedCommand {
  label: string;
  command: string;
  source: string;
  cwd?: string | null;
}

/** Contents of a project's `.bluephoenix` file. */
export interface ProjectFile {
  name: string;
  description: string | null;
  kind: string | null;
  githubUrl: string | null;
  websiteUrl: string | null;
  defaultEditor: string | null;
  defaultTerminal: string | null;
  commands: { label: string; command: string; cwd: string | null; source: string | null }[];
}

export interface Detected {
  name: string;
  kind: string;
  description: string | null;
  githubUrl: string | null;
  isGit: boolean;
  commands: DetectedCommand[];
}

export interface FileEntry {
  relPath: string;
  size: number;
  mtime: number;
}

export interface Provider {
  id: string;
  name: string;
  local: boolean;
  baseUrl: string;
  needsKey: boolean;
  protocol: "openai" | "anthropic";
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  downloadUrl: string | null;
}

export interface CliStatus {
  installed: boolean;
  upToDate: boolean;
  path: string | null;
  onPath: boolean;
}

export interface SystemInfo {
  platform: "macos" | "windows" | "linux";
  version: string;
  home: string | null;
}

export type Settings = Record<string, string>;

export interface SyncReport {
  pushed: number;
  pulled: number;
}

export interface SyncStatus {
  connected: boolean;
  host: string | null;
  lastSync: number | null;
  lastError: string | null;
}

export type AutomationTrigger = "launch" | "quit" | "manual" | "schedule" | "commit";
export type AutomationNotify = "none" | "on_run" | "before";

export interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** Epoch ms: the first time it may run. */
  runAt: number | null;
  repeatHours: number | null;
  notify: AutomationNotify;
  notifyBeforeMin: number | null;
  targetMode: "selected" | "all";
  projectIds: string[];
  /** Project type to narrow "all projects" to, e.g. "Tauri". */
  kindFilter: string | null;
  /** Requisite: not edited for this many hours. */
  idleHours: number | null;
  requireCleanGit: boolean;
  requireGitRepo: boolean;
  commands: string;
  sort: number;
  lastRun?: number | null;
  lastStatus?: "ok" | "failed" | "timeout" | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  projectId: string;
  projectName: string;
  startedAt: number;
  finishedAt: number;
  status: "ok" | "failed" | "timeout";
  exitCode: number | null;
  output: string;
}

export interface AutomationSummary {
  automationId: string;
  name: string;
  notify: AutomationNotify;
  ok: number;
  failed: number;
  skipped: { project: string; reason: string }[];
}

export type ForkStatus = "up-to-date" | "safe" | "conflicting" | "pulled" | "unknown" | "error";

/** A GitHub fork's upstream sync settings and the result of the last check. */
export interface ForkSync {
  projectId: string;
  isFork: boolean;
  upstreamRemote: string;
  upstreamUrl: string | null;
  /** Branch to compare with; the current branch when empty. */
  upstreamBranch: string | null;
  autoCheck: boolean;
  intervalMinutes: number;
  autoPull: boolean;
  lastCheck: number | null;
  lastPull: number | null;
  status: ForkStatus | null;
  behind: number;
  ahead: number;
  message: string | null;
  /** The installed git version when it is too old (< 2.38) to predict conflicts; null otherwise. */
  oldGit: string | null;
}

// ---------- new project wizard ----------

export interface InitResult {
  ok: boolean;
  cancelled: boolean;
  path: string;
  failedStep: number | null;
  error: string | null;
}

export interface InitProgress {
  runId: string;
  step: number;
  status: "start" | "ok" | "warn" | "error" | "log";
  line: string | null;
}

export interface IconInfo {
  width: number;
  height: number;
  dataUrl: string;
}

export interface Preflight {
  path: string;
  exists: boolean;
  empty: boolean;
  parentExists: boolean;
}
