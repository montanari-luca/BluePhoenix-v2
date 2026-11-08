import { api, errMsg, uid } from "./api";
import { useStore } from "./store";
import { openSession } from "./terminals";
import type { Command, Project } from "./types";

let navigator: (to: string) => void = () => undefined;
export const setNavigator = (fn: (to: string) => void) => (navigator = fn);
export const navigate = (to: string) => navigator(to);

const toast = (t: Parameters<ReturnType<typeof useStore.getState>["toast"]>[0]) => useStore.getState().toast(t);

export function hasFolder(p: Project): boolean {
  return p.path.trim().length > 0;
}

export function defaultEditorId(p: Project): string {
  const { settings, editors } = useStore.getState();
  const pick = [p.defaultEditor, settings.defaultEditor].find((id) => id && (id === "system" || editors.some((e) => e.id === id)));
  return pick ?? editors[0]?.id ?? "system";
}

export function editorName(id: string): string {
  if (id === "system") return "default app";
  const name = useStore.getState().editors.find((e) => e.id === id)?.name ?? id;
  return name.replace("Visual Studio Code", "VS Code").replace("IntelliJ IDEA", "IDEA");
}

export function defaultCommand(p: Project, cmds: Command[]): Command | undefined {
  return (
    cmds.find((c) => c.id === p.defaultCommandId) ??
    cmds.find((c) => /build/i.test(c.label)) ??
    cmds.find((c) => /(dev|start|run)/i.test(c.label)) ??
    cmds[0]
  );
}

export async function openEditor(p: Project, editor?: string, relPath?: string) {
  if (!hasFolder(p)) return toast({ kind: "info", title: "This project has no folder" });
  const id = editor ?? defaultEditorId(p);
  if (id === "embedded") return openTerminal(p, "embedded");
  try {
    const target = relPath ? `${p.path.replace(/[\\/]+$/, "")}/${relPath}` : p.path;
    await api.openInEditor(id, target);
    void api.touchProject(p.id).then(() => useStore.getState().loadProjects());
  } catch (e) {
    toast({ kind: "error", title: `Could not open in ${editorName(id)}`, detail: errMsg(e) });
  }
}

/** target: "embedded" | a terminal id | undefined (use default). */
export async function openTerminal(p: Project, target?: string, command?: string, title?: string) {
  if (!hasFolder(p)) return toast({ kind: "info", title: "This project has no folder" });
  const { settings } = useStore.getState();
  const t = target ?? p.defaultTerminal ?? settings.defaultTerminal ?? "embedded";
  try {
    if (t === "embedded") {
      await openSession(p.id, p.path, title ?? (command ? command.slice(0, 24) : "Terminal"), command);
      navigate(`/project/${p.id}?tab=terminal`);
    } else {
      await api.openInTerminal(t === "system" ? "" : t, p.path, command);
    }
    void api.touchProject(p.id).then(() => useStore.getState().loadProjects());
  } catch (e) {
    toast({ kind: "error", title: "Could not open the terminal", detail: errMsg(e) });
  }
}

export async function runCommand(p: Project, c: Command, target?: string) {
  const { settings } = useStore.getState();
  const t = target ?? settings.runIn ?? "embedded";
  const cwdProject = c.cwd ? { ...p, path: c.cwd.startsWith("/") || /^[A-Za-z]:/.test(c.cwd) ? c.cwd : `${p.path}/${c.cwd}` } : p;
  await openTerminal(cwdProject, t, c.command, c.label);
}

export type GitAction = "fetch" | "pull" | "push" | "stash" | "stashApply";

const GIT_LABEL: Record<GitAction, string> = {
  fetch: "Fetching",
  pull: "Pulling",
  push: "Pushing",
  stash: "Stashing changes",
  stashApply: "Applying last stash",
};

export async function gitAction(p: Project, action: GitAction): Promise<boolean> {
  if (!hasFolder(p)) {
    toast({ kind: "info", title: "This project has no folder" });
    return false;
  }
  const { setBusy, refreshStatus } = useStore.getState();
  setBusy(p.id, GIT_LABEL[action]);
  try {
    const fn = {
      fetch: api.gitFetch,
      pull: api.gitPull,
      push: api.gitPush,
      stash: (path: string) => api.gitStash(path),
      stashApply: api.gitStashApply,
    }[action];
    const out = await fn(p.path);
    toast({ kind: "success", title: `${p.name}: ${GIT_LABEL[action].toLowerCase()} done`, detail: out.slice(0, 300) });
    return true;
  } catch (e) {
    toast({ kind: "error", title: `${p.name}: ${GIT_LABEL[action].toLowerCase()} failed`, detail: errMsg(e) });
    return false;
  } finally {
    setBusy(p.id, undefined);
    void refreshStatus(p.id);
  }
}

export function openExternal(url: string | null | undefined) {
  if (!url) return;
  api.openUrl(url).catch((e) => toast({ kind: "error", title: "Could not open link", detail: errMsg(e) }));
}

export async function toggleFavorite(p: Project) {
  await api.saveProject({ ...p, favorite: !p.favorite });
  await useStore.getState().loadProjects();
}

export async function setArchived(p: Project, archived: boolean) {
  await api.archiveProject(p.id, archived);
  await useStore.getState().loadProjects();
  toast(
    archived
      ? { kind: "success", title: `Archived ${p.name}`, detail: "Find it under Archived on the dashboard." }
      : { kind: "success", title: `Restored ${p.name}` },
  );
}

export async function removeProject(p: Project) {
  await api.removeProject(p.id);
  await useStore.getState().loadProjects();
  toast({ kind: "success", title: `Removed ${p.name}`, detail: "Your files were not touched." });
}

export async function logTime(p: Project, minutes: number, note?: string, todoId?: string | null, at?: number) {
  await api.saveTime({
    id: uid(),
    projectId: p.id,
    todoId: todoId ?? null,
    minutes,
    loggedAt: at ?? Date.now(),
    note: note?.trim() || null,
  });
  await useStore.getState().loadProjects();
}
