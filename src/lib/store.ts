import { create } from "zustand";
import { api, errMsg } from "./api";
import { applyTheme } from "./theme";
import type { AppInfo, Automation, Command, ForkSync, GitStatus, ProjectSummary, Settings, SystemInfo } from "./types";

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  detail?: string;
}

interface State {
  ready: boolean;
  system: SystemInfo | null;
  settings: Settings;
  projects: ProjectSummary[];
  statuses: Record<string, GitStatus | null>;
  commands: Record<string, Command[]>;
  automations: Automation[];
  /** Forks only, by project id. */
  forks: Record<string, ForkSync>;
  editors: AppInfo[];
  terminals: AppInfo[];
  toasts: Toast[];
  paletteOpen: boolean;
  addProjectOpen: boolean;
  newProjectOpen: boolean;
  /** project id -> label of the running action */
  busy: Record<string, string | undefined>;
  update: { latest: string; downloadUrl: string | null } | null;

  init: () => Promise<void>;
  loadProjects: () => Promise<void>;
  refreshStatus: (id: string) => Promise<GitStatus | null>;
  refreshAllStatuses: () => Promise<void>;
  loadCommands: (id: string) => Promise<Command[]>;
  loadAutomations: () => Promise<void>;
  loadForks: () => Promise<void>;
  setForks: (list: ForkSync[]) => void;
  setSetting: (key: string, value: string) => Promise<void>;
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  setPalette: (open: boolean) => void;
  setAddProject: (open: boolean) => void;
  setNewProject: (open: boolean) => void;
  setBusy: (id: string, label?: string) => void;
  setUpdate: (u: State["update"]) => void;
}

let toastId = 1;

export const useStore = create<State>((set, get) => ({
  ready: false,
  system: null,
  settings: {},
  projects: [],
  statuses: {},
  commands: {},
  automations: [],
  forks: {},
  editors: [],
  terminals: [],
  toasts: [],
  paletteOpen: false,
  addProjectOpen: false,
  newProjectOpen: false,
  busy: {},
  update: null,

  init: async () => {
    try {
      const [system, settings, editors, terminals] = await Promise.all([
        api.systemInfo(),
        api.settings(),
        api.editors(),
        api.terminals(),
      ]);
      document.documentElement.classList.add(`os-${system.platform}`);
      document.body.classList.add(`os-${system.platform}`);
      set({ system, settings, editors, terminals });
      applyTheme(settings.theme ?? "system", settings.accent);
      await get().loadProjects();
      void get().loadForks();
    } catch (e) {
      get().toast({ kind: "error", title: "Could not start BluePhoenix", detail: errMsg(e) });
    } finally {
      set({ ready: true });
    }
    get().refreshAllStatuses();
  },

  loadProjects: async () => {
    try {
      set({ projects: await api.projects() });
    } catch (e) {
      get().toast({ kind: "error", title: "Could not load projects", detail: errMsg(e) });
    }
  },

  refreshStatus: async (id) => {
    const p = get().projects.find((x) => x.id === id);
    if (!p || !p.path) return null;
    try {
      const s = await api.gitStatus(p.path);
      set((st) => ({ statuses: { ...st.statuses, [id]: s } }));
      return s;
    } catch {
      set((st) => ({ statuses: { ...st.statuses, [id]: null } }));
      return null;
    }
  },

  refreshAllStatuses: async () => {
    await Promise.all(get().projects.map((p) => get().refreshStatus(p.id)));
  },

  loadCommands: async (id) => {
    const cmds = await api.commands(id).catch(() => [] as Command[]);
    set((st) => ({ commands: { ...st.commands, [id]: cmds } }));
    return cmds;
  },

  loadAutomations: async () => {
    try {
      set({ automations: await api.automations() });
    } catch (e) {
      get().toast({ kind: "error", title: "Could not load automations", detail: errMsg(e) });
    }
  },

  loadForks: async () => {
    try {
      get().setForks(await api.forks());
    } catch {
      /* the fork badge is optional */
    }
  },

  setForks: (list) =>
    set((st) => {
      const forks = { ...st.forks };
      for (const f of list) {
        if (f.isFork) forks[f.projectId] = f;
        else delete forks[f.projectId];
      }
      return { forks };
    }),

  setSetting: async (key, value) => {
    set((st) => ({ settings: { ...st.settings, [key]: value } }));
    await api.setSetting(key, value);
    if (key === "theme" || key === "accent") {
      const s = get().settings;
      applyTheme(s.theme ?? "system", s.accent);
    }
  },

  toast: (t) => {
    const id = toastId++;
    set((st) => ({ toasts: [...st.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.kind === "error" ? 9000 : 4500);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setAddProject: (addProjectOpen) => set({ addProjectOpen }),
  setNewProject: (newProjectOpen) => set({ newProjectOpen }),
  setBusy: (id, label) => set((st) => ({ busy: { ...st.busy, [id]: label } })),
  setUpdate: (update) => set({ update }),
}));
