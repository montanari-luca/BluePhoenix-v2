import { listen } from "@tauri-apps/api/event";
import { GitMerge, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { logError, useStore } from "../../lib/store";
import type { SyncConflict } from "../../lib/types";
import { Section } from "./Shared";

const KIND: Record<string, string> = {
  projects: "Project",
  todos: "To-do",
  todo_pages: "Page",
  commands: "Command",
  time_entries: "Time entry",
  fork_sync: "Fork settings",
  project_git: "Git summary",
};

const FIELD: Record<string, string> = { deleted: "Deleted", archived_at: "Archived", completed_at: "Completed" };

function show(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" && /_at$|^due$|^logged_at$/.test(field)) return new Date(v).toLocaleString();
  const s = String(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

/** Edits from this computer that lost to a newer edit made elsewhere. Hidden when there are none. */
export function ConflictsSection() {
  const toast = useStore((s) => s.toast);
  const loadProjects = useStore((s) => s.loadProjects);
  const [items, setItems] = useState<SyncConflict[]>([]);

  const refresh = useCallback(() => api.syncConflicts().then(setItems).catch(logError("sync conflicts")), []);
  useEffect(() => {
    void refresh();
    const un = listen("sync-finished", () => void refresh());
    return () => void un.then((f) => f());
  }, [refresh]);

  async function restore(c: SyncConflict) {
    try {
      await api.syncConflictRestore(c.id);
      await Promise.all([refresh(), loadProjects()]);
      toast({ kind: "success", title: "Restored your version", detail: "It replaces the other one on the next sync." });
    } catch (e) {
      toast({ kind: "error", title: "Could not restore", detail: errMsg(e) });
    }
  }

  async function dismiss(id?: string) {
    await api.syncConflictDismiss(id).catch(logError("dismiss conflict"));
    await refresh();
  }

  // Conflicts where nothing differs any more (same edit on both sides) are not worth showing.
  const shown = items.filter((c) => c.diffs.length > 0);
  if (shown.length === 0) return null;

  return (
    <Section
      id="conflicts"
      title={`Sync conflicts (${shown.length})`}
      desc="These edits from this computer were replaced by newer edits from another device. Restore yours or keep the newer one."
    >
      <ul className="flex flex-col gap-3">
        {shown.map((c) => (
          <li key={c.id} className="rounded-xl border border-[var(--line)] p-3">
            <div className="flex items-center gap-2 text-[13px]">
              <GitMerge size={14} className="shrink-0 text-[var(--accent)]" />
              <span className="font-medium">{KIND[c.table] ?? c.table}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--fg-muted)]">{c.label ?? c.rowId}</span>
              <span className="text-xs text-[var(--fg-faint)]">{timeAgo(c.createdAt)}</span>
            </div>
            <table className="mt-2 w-full table-fixed text-xs">
              <thead className="text-left text-[var(--fg-faint)]">
                <tr>
                  <th className="w-28 font-normal">Field</th>
                  <th className="font-normal">Yours</th>
                  <th className="font-normal">Now</th>
                </tr>
              </thead>
              <tbody>
                {c.diffs.map((d) => (
                  <tr key={d.field} className="align-top">
                    <td className="py-0.5 pr-2 text-[var(--fg-muted)]">{FIELD[d.field] ?? d.field.replace(/_/g, " ")}</td>
                    <td className="py-0.5 pr-2 break-words">{show(d.field, d.mine)}</td>
                    <td className="py-0.5 break-words">{show(d.field, d.current)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex justify-end gap-2">
              <button className="btn btn-sm btn-ghost" onClick={() => void dismiss(c.id)}>
                <X size={14} /> Keep the newer one
              </button>
              <button className="btn btn-sm" onClick={() => void restore(c)}>
                <Undo2 size={14} /> Restore mine
              </button>
            </div>
          </li>
        ))}
      </ul>
      {shown.length > 1 && (
        <div className="mt-3 flex justify-end">
          <button className="btn btn-sm btn-ghost" onClick={() => void dismiss()}>
            Keep the newer ones for all
          </button>
        </div>
      )}
    </Section>
  );
}
