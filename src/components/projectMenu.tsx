import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Archive,
  ArchiveRestore,
  Code2,
  ExternalLink,
  FolderArchive,
  FolderOpen,
  Globe,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Terminal,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  defaultEditorId,
  gitAction,
  hasFolder,
  navigate,
  openEditor,
  openExternal,
  openTerminal,
  setArchived,
} from "../lib/actions";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { Project } from "../lib/types";
import { Github, type MenuItem } from "./ui";

/** Every project action, shared by the card menu, the project header and the palette. */
export function buildProjectMenu(p: Project, opts: { onRemove: () => void; onEdit?: () => void }): MenuItem[] {
  const folder = hasFolder(p);
  const git = (a: Parameters<typeof gitAction>[1]) => () => void gitAction(p, a);
  const items: MenuItem[] = [
    { label: "Open in terminal", icon: <Terminal size={15} />, onClick: () => void openTerminal(p), disabled: !folder },
    { label: "Reveal folder", icon: <FolderOpen size={15} />, onClick: () => void api.reveal(p.path), disabled: !folder },
    { separator: true },
    { label: "Fetch", icon: <RefreshCw size={15} />, onClick: git("fetch"), disabled: !folder },
    { label: "Pull", icon: <ArrowDownToLine size={15} />, onClick: git("pull"), disabled: !folder },
    { label: "Push", icon: <ArrowUpFromLine size={15} />, onClick: git("push"), disabled: !folder },
    { label: "Stash changes", icon: <Archive size={15} />, onClick: git("stash"), disabled: !folder },
    { label: "Apply last stash", icon: <ArchiveRestore size={15} />, onClick: git("stashApply"), disabled: !folder },
    { separator: true },
    { label: "GitHub", icon: <Github size={15} />, onClick: () => openExternal(p.githubUrl), disabled: !p.githubUrl },
    { label: "Website", icon: <Globe size={15} />, onClick: () => openExternal(p.websiteUrl), disabled: !p.websiteUrl },
    { separator: true },
  ];
  if (opts.onEdit) items.push({ label: "Edit project…", icon: <Pencil size={15} />, onClick: opts.onEdit });
  items.push(
    p.archivedAt
      ? { label: "Restore from archive", icon: <Undo2 size={15} />, onClick: () => void setArchived(p, false) }
      : { label: "Archive project", icon: <FolderArchive size={15} />, onClick: () => void setArchived(p, true) },
  );
  items.push({ label: "Remove project", icon: <Trash2 size={15} />, onClick: opts.onRemove, danger: true });
  return items;
}

/** The "Open in…" drop-down: editors, terminals, file manager. */
export function buildEditorMenu(p: Project): MenuItem[] {
  const { editors, terminals } = useStore.getState();
  const current = defaultEditorId(p);
  const items: MenuItem[] = [{ label: "Open in editor", header: true }];
  for (const e of editors) {
    items.push({
      label: e.name,
      icon: <Code2 size={15} />,
      checked: e.id === current,
      onClick: () => void openEditor(p, e.id),
    });
  }
  items.push({ label: "System default app", icon: <ExternalLink size={15} />, onClick: () => void openEditor(p, "system") });
  items.push({ separator: true });
  items.push({ label: "Open in terminal", header: true });
  items.push({ label: "Embedded terminal", icon: <SquareTerminal size={15} />, onClick: () => void openTerminal(p, "embedded") });
  items.push({ label: "System terminal", icon: <Terminal size={15} />, onClick: () => void openTerminal(p, "system") });
  for (const t of terminals) {
    items.push({ label: t.name, icon: <Terminal size={15} />, onClick: () => void openTerminal(p, t.id) });
  }
  items.push({ separator: true });
  items.push({ label: "Reveal in file manager", icon: <FolderOpen size={15} />, onClick: () => void api.reveal(p.path) });
  return items;
}

export function goToProject(id: string, tab?: string) {
  navigate(`/project/${id}${tab ? `?tab=${tab}` : ""}`);
}
