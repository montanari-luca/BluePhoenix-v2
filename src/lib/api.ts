import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  Automation,
  AutomationRun,
  AutomationSummary,
  Branch,
  CliStatus,
  Command,
  Commit,
  Detected,
  FileEntry,
  GitStatus,
  Project,
  ProjectSummary,
  Provider,
  Settings,
  SyncReport,
  SyncStatus,
  SystemInfo,
  TimeEntry,
  Todo,
  TodoPage,
  UpdateInfo,
} from "./types";

export const uid = () => crypto.randomUUID();

export const api = {
  systemInfo: () => invoke<SystemInfo>("system_info"),

  // data
  projects: () => invoke<ProjectSummary[]>("projects_list"),
  saveProject: (project: Project) => invoke<Project>("project_save", { project }),
  touchProject: (id: string) => invoke<void>("project_touch", { id }),
  removeProject: (id: string) => invoke<void>("project_remove", { id }),
  commands: (projectId: string) => invoke<Command[]>("commands_list", { projectId }),
  saveCommand: (command: Command) => invoke<void>("command_save", { command }),
  deleteCommand: (id: string) => invoke<void>("command_delete", { id }),
  pages: (projectId: string) => invoke<TodoPage[]>("pages_list", { projectId }),
  savePage: (page: TodoPage) => invoke<void>("page_save", { page }),
  deletePage: (id: string) => invoke<void>("page_delete", { id }),
  todos: (projectId: string) => invoke<Todo[]>("todos_list", { projectId }),
  saveTodo: (todo: Todo) => invoke<void>("todo_save", { todo }),
  saveTodos: (todos: Todo[]) => invoke<void>("todos_save_many", { todos }),
  deleteTodo: (id: string) => invoke<void>("todo_delete", { id }),
  time: (projectId: string) => invoke<TimeEntry[]>("time_list", { projectId }),
  saveTime: (entry: TimeEntry) => invoke<void>("time_save", { entry }),
  deleteTime: (id: string) => invoke<void>("time_delete", { id }),
  settings: () => invoke<Settings>("settings_get_all"),
  setSetting: (key: string, value: string) => invoke<void>("settings_set", { key, value }),

  // automations
  automations: () => invoke<Automation[]>("automations_list"),
  saveAutomation: (automation: Automation) => invoke<Automation>("automation_save", { automation }),
  deleteAutomation: (id: string) => invoke<void>("automation_delete", { id }),
  automationRuns: (id: string) => invoke<AutomationRun[]>("automation_runs", { id }),
  runAutomation: (id: string, projectId?: string) => invoke<AutomationSummary>("automation_run", { id, projectId }),

  // git
  gitStatus: (path: string) => invoke<GitStatus>("git_status", { path }),
  gitBranches: (path: string) => invoke<Branch[]>("git_branches", { path }),
  gitTags: (path: string) => invoke<string[]>("git_tags", { path }),
  gitLog: (path: string, limit?: number, range?: string) => invoke<Commit[]>("git_log", { path, limit, range }),
  gitDiff: (path: string, staged: boolean, file?: string) => invoke<string>("git_diff", { path, staged, file }),
  gitShow: (path: string, hash: string) => invoke<string>("git_show", { path, hash }),
  gitFetch: (path: string) => invoke<string>("git_fetch", { path }),
  gitPull: (path: string) => invoke<string>("git_pull", { path }),
  gitPush: (path: string) => invoke<string>("git_push", { path }),
  gitStash: (path: string, message?: string) => invoke<string>("git_stash", { path, message }),
  gitStashApply: (path: string) => invoke<string>("git_stash_apply", { path }),
  gitStashList: (path: string) => invoke<string[]>("git_stash_list", { path }),
  gitCheckout: (path: string, name: string, remote: boolean) => invoke<string>("git_checkout", { path, name, remote }),
  gitCreateBranch: (path: string, name: string, from?: string) =>
    invoke<string>("git_create_branch", { path, name, from }),
  gitDeleteBranch: (path: string, name: string, force: boolean) =>
    invoke<string>("git_delete_branch", { path, name, force }),
  gitMerge: (path: string, name: string) => invoke<string>("git_merge", { path, name }),
  gitMergeAbort: (path: string) => invoke<string>("git_merge_abort", { path }),
  gitStage: (path: string, files: string[]) => invoke<void>("git_stage", { path, files }),
  gitUnstage: (path: string, files: string[]) => invoke<void>("git_unstage", { path, files }),
  gitCommit: (path: string, message: string) => invoke<string>("git_commit", { path, message }),
  gitInit: (path: string) => invoke<string>("git_init", { path }),

  // launch
  editors: () => invoke<AppInfo[]>("list_editors"),
  terminals: () => invoke<AppInfo[]>("list_terminals"),
  openInEditor: (editor: string, path: string) => invoke<void>("open_in_editor", { editor, path }),
  openInTerminal: (terminal: string, path: string, command?: string) =>
    invoke<void>("open_in_terminal", { terminal, path, command }),
  reveal: (path: string) => invoke<void>("reveal_path", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),

  // terminal
  ptyOpen: (cwd: string, command: string | undefined, cols: number, rows: number) =>
    invoke<string>("pty_open", { cwd, command, cols, rows }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),

  // detection + files
  detect: (path: string) => invoke<Detected>("detect_project", { path }),
  snapshot: (path: string) => invoke<string>("project_snapshot", { path }),
  indexFiles: (projectId: string, path: string) =>
    invoke<{ count: number; truncated: boolean }>("files_index", { projectId, path }),
  files: (projectId: string, query?: string, limit?: number) =>
    invoke<FileEntry[]>("files_list", { projectId, query, limit }),
  filesCount: (projectId: string) => invoke<number>("files_count", { projectId }),

  // ai
  providers: () => invoke<Provider[]>("ai_providers"),
  aiModels: (providerId: string, baseUrl?: string, apiKey?: string) =>
    invoke<string[]>("ai_models", { providerId, baseUrl, apiKey }),
  aiComplete: (system: string, prompt: string, maxTokens?: number, jsonMode?: boolean) =>
    invoke<string>("ai_complete", { system, prompt, maxTokens, jsonMode }),
  secretSet: (name: string, value: string) => invoke<void>("secret_set", { name, value }),
  secretHas: (name: string) => invoke<boolean>("secret_has", { name }),
  aiEnsureLocal: () => invoke<{ provider: string; state: "running" | "started" | "failed"; message: string } | null>("ai_ensure_local"),
  llamaStart: (ggufPath: string, port?: number) => invoke<string>("llama_start", { ggufPath, port }),
  llamaStop: () => invoke<void>("llama_stop"),

  // cloud sync
  syncTest: (url: string) => invoke<string>("sync_test", { url }),
  syncConnect: (url: string) => invoke<SyncReport>("sync_connect", { url }),
  syncNow: () => invoke<SyncReport>("sync_now"),
  syncDisconnect: () => invoke<void>("sync_disconnect"),
  syncStatus: () => invoke<SyncStatus>("sync_status"),

  // command line
  cliStatus: () => invoke<CliStatus>("cli_status"),
  cliInstall: () => invoke<CliStatus>("cli_install"),
  cliUninstall: () => invoke<CliStatus>("cli_uninstall"),

  // updater
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
  downloadUpdate: (url: string) => invoke<string>("download_update", { url }),
  installUpdate: (path: string) => invoke<void>("install_update", { path }),
  quit: () => invoke<void>("quit_app"),
};

export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Something went wrong";
}
