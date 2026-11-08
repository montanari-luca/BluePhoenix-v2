import { Command } from "cmdk";
import {
  Archive, ArchiveRestore, ArrowDownToLine, ArrowUpFromLine, Clock, Code2, FolderOpen, FolderPlus, Globe, LayoutDashboard,
  Moon, Palette, Play, RefreshCw, Search, Settings as SettingsIcon, Sparkles, SquareTerminal, Star, Sun, Terminal, Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { bulkGit, gitAction, hasFolder, logTime, navigate, openEditor, openExternal, openTerminal, runCommand, toggleFavorite } from "../lib/actions";
import { api, errMsg } from "../lib/api";
import { formatMinutes } from "../lib/format";
import { useStore } from "../lib/store";
import { Github, Kbd } from "./ui";

interface Item {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  keywords?: string[];
  run: () => void | Promise<void>;
}
interface Group {
  heading: string;
  items: Item[];
}

const TAB_LABELS: [string, string][] = [
  ["overview", "Overview"], ["git", "Git"], ["todos", "To-dos"], ["time", "Time"],
  ["commands", "Commands"], ["terminal", "Terminal"], ["files", "Files"], ["changelog", "Changelog"],
];

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPalette);
  const projects = useStore((s) => s.projects);
  const editors = useStore((s) => s.editors);
  const terminals = useStore((s) => s.terminals);
  const cmdsByProject = useStore((s) => s.commands);
  const loadCommands = useStore((s) => s.loadCommands);
  const setSetting = useStore((s) => s.setSetting);
  const setAdd = useStore((s) => s.setAddProject);
  const setNew = useStore((s) => s.setNewProject);
  const refreshAll = useStore((s) => s.refreshAllStatuses);
  const toast = useStore((s) => s.toast);
  const setUpdate = useStore((s) => s.setUpdate);
  const nav = useNavigate();
  const match = useMatch("/project/:id");
  const current = projects.find((p) => p.id === match?.params.id);
  const [query, setQuery] = useState("");

  // ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useStore.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      setQuery("");
      if (current && !cmdsByProject[current.id]) void loadCommands(current.id);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo<Group[]>(() => {
    const g: Group[] = [];
    if (current) {
      const p = current;
      const folder = hasFolder(p);
      const cmds = cmdsByProject[p.id] ?? [];
      const ico = (n: ReactNode) => n;
      const proj: Item[] = [
        ...(folder
          ? [
              { id: "fetch", label: "Fetch", icon: ico(<RefreshCw size={15} />), run: () => void gitAction(p, "fetch") },
              { id: "pull", label: "Pull", icon: ico(<ArrowDownToLine size={15} />), run: () => void gitAction(p, "pull") },
              { id: "push", label: "Push", icon: ico(<ArrowUpFromLine size={15} />), run: () => void gitAction(p, "push") },
              { id: "stash", label: "Stash changes", icon: ico(<Archive size={15} />), run: () => void gitAction(p, "stash") },
              { id: "apply", label: "Apply last stash", icon: ico(<ArchiveRestore size={15} />), run: () => void gitAction(p, "stashApply") },
              { id: "editor", label: "Open in default editor", icon: ico(<Code2 size={15} />), run: () => void openEditor(p) },
              ...editors.map((e) => ({ id: `ed-${e.id}`, label: `Open in ${e.name}`, icon: ico(<Code2 size={15} />), run: () => void openEditor(p, e.id) })),
              { id: "term-e", label: "Open embedded terminal", icon: ico(<SquareTerminal size={15} />), run: () => void openTerminal(p, "embedded") },
              { id: "term-s", label: "Open in system terminal", icon: ico(<Terminal size={15} />), run: () => void openTerminal(p, "system") },
              ...terminals.map((t) => ({ id: `tm-${t.id}`, label: `Open in ${t.name}`, icon: ico(<Terminal size={15} />), run: () => void openTerminal(p, t.id) })),
              { id: "reveal", label: "Reveal folder", icon: ico(<FolderOpen size={15} />), run: () => void api.reveal(p.path) },
            ]
          : []),
        ...(p.githubUrl ? [{ id: "gh", label: "Open on GitHub", icon: ico(<Github size={15} />), run: () => openExternal(p.githubUrl) }] : []),
        ...(p.websiteUrl ? [{ id: "web", label: "Open website", icon: ico(<Globe size={15} />), run: () => openExternal(p.websiteUrl) }] : []),
        { id: "fav", label: p.favorite ? "Remove from favorites" : "Add to favorites", icon: ico(<Star size={15} />), run: () => void toggleFavorite(p) },
      ];
      g.push({ heading: `${p.name}`, items: proj });
      if (folder && cmds.length)
        g.push({ heading: `Run in ${p.name}`, items: cmds.map((c) => ({ id: `run-${c.id}`, label: c.label, hint: c.command, icon: <Play size={15} />, run: () => void runCommand(p, c) })) });
      g.push({
        heading: "Log time",
        items: [10, 15, 30, 60, 120].map((m) => ({
          id: `time-${m}`, label: `Log ${formatMinutes(m)} on ${p.name}`, icon: <Clock size={15} />, keywords: ["time", "track"],
          run: async () => {
            try {
              await logTime(p, m);
              toast({ kind: "success", title: `Logged ${formatMinutes(m)}`, detail: p.name });
            } catch (e) {
              toast({ kind: "error", title: "Could not log time", detail: errMsg(e) });
            }
          },
        })),
      });
      g.push({ heading: "Go to tab", items: TAB_LABELS.map(([id, label]) => ({ id: `tab-${id}`, label: `${p.name}: ${label}`, run: () => nav(`/project/${p.id}?tab=${id}`) })) });
    }
    g.push({
      heading: "Navigate",
      items: [
        { id: "dash", label: "Dashboard", icon: <LayoutDashboard size={15} />, run: () => nav("/") },
        { id: "automations", label: "Automations", icon: <Zap size={15} />, keywords: ["automation", "schedule", "cron", "chores"], run: () => nav("/automations") },
        { id: "settings", label: "Settings", icon: <SettingsIcon size={15} />, run: () => nav("/settings") },
        { id: "settings-ai", label: "Settings: AI providers", icon: <Sparkles size={15} />, run: () => nav("/settings?section=ai") },
        { id: "settings-sync", label: "Settings: Cloud sync", icon: <SettingsIcon size={15} />, run: () => nav("/settings?section=sync") },
      ],
    });
    g.push({
      heading: "Projects",
      items: projects.filter((p) => p.id !== current?.id && !p.archivedAt).map((p) => ({ id: `proj-${p.id}`, label: p.name, hint: p.kind, icon: <Code2 size={15} />, keywords: [p.kind, p.description ?? ""], run: () => nav(`/project/${p.id}`) })),
    });
    g.push({
      heading: "General",
      items: [
        { id: "add", label: "Add project…", icon: <FolderPlus size={15} />, run: () => { nav("/"); setAdd(true); } },
        { id: "new", label: "New project…", icon: <Sparkles size={15} />, run: () => { nav("/"); setNew(true); } },
        { id: "refresh", label: "Refresh all git statuses", icon: <RefreshCw size={15} />, run: () => void refreshAll() },
        { id: "fetch-all", label: "Fetch all projects", icon: <RefreshCw size={15} />, run: () => void bulkGit(projects, "fetch") },
        { id: "pull-all", label: "Pull all clean projects (fast-forward)", icon: <RefreshCw size={15} />, run: () => void bulkGit(projects, "pull") },
        { id: "theme-light", label: "Theme: Light", icon: <Sun size={15} />, run: () => void setSetting("theme", "light") },
        { id: "theme-dark", label: "Theme: Dark", icon: <Moon size={15} />, run: () => void setSetting("theme", "dark") },
        { id: "theme-system", label: "Theme: Follow system", icon: <Palette size={15} />, run: () => void setSetting("theme", "system") },
        {
          id: "update", label: "Check for updates", icon: <RefreshCw size={15} />,
          run: async () => {
            try {
              const r = await api.checkUpdate();
              setUpdate(r.available ? { latest: r.latest, downloadUrl: r.downloadUrl } : null);
              if (r.available) { toast({ kind: "info", title: `Version ${r.latest} is available` }); navigate("/settings?section=updates"); }
              else toast({ kind: "success", title: "You're up to date", detail: `Version ${r.current}` });
            } catch (e) {
              toast({ kind: "error", title: "Update check failed", detail: errMsg(e) });
            }
          },
        },
      ],
    });
    return g.filter((x) => x.items.length > 0);
  }, [current, projects, editors, terminals, cmdsByProject, nav, setAdd, setNew, refreshAll, setSetting, toast, setUpdate]);

  if (!open) return null;
  const close = () => setOpen(false);

  return (
    <div
      className="fixed inset-0 z-[250] flex items-start justify-center pt-[12vh]"
      style={{ background: "rgba(10,14,30,0.3)", backdropFilter: "blur(5px)" }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <Command className="glass-strong pop w-[640px] max-w-[92vw] overflow-hidden" loop label="Command palette">
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-4">
          <Search size={16} className="text-[var(--fg-faint)]" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={current ? `Search actions for ${current.name} and everything else…` : "Search projects and actions…"}
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--fg-faint)]"
            onKeyDown={(e) => e.key === "Escape" && close()}
          />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[52vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-8 text-center text-[13px] text-[var(--fg-faint)]">No matching action.</Command.Empty>
          {groups.map((grp) => (
            <Command.Group key={grp.heading} heading={grp.heading}>
              {grp.items.map((it) => (
                <Command.Item
                  key={it.id}
                  value={`${grp.heading} ${it.label} ${it.hint ?? ""}`}
                  keywords={it.keywords}
                  onSelect={() => {
                    close();
                    void it.run();
                  }}
                >
                  <span className="flex w-5 justify-center opacity-80">{it.icon}</span>
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="max-w-[40%] truncate font-mono text-xs text-[var(--fg-faint)]">{it.hint}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
