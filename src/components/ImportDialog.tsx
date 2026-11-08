import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderSearch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../lib/api";
import { useStore } from "../lib/store";
import type { FoundRepo } from "../lib/types";
import { Modal, Segmented, Spinner } from "./ui";

/** Finds every git repository in a folder and adds the chosen ones as projects in one go. */
export function ImportDialog({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const loadProjects = useStore((s) => s.loadProjects);
  const refreshAll = useStore((s) => s.refreshAllStatuses);
  const system = useStore((s) => s.system);
  const [root, setRoot] = useState("");
  const [depth, setDepth] = useState<"2" | "3" | "4">("3");
  const [found, setFound] = useState<FoundRepo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"scan" | "add" | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setFound(null);
    setPicked(new Set());
    setRoot((r) => r || (system?.home ? `${system.home}/Developer` : ""));
  }, [isOpen, system?.home]);

  async function scan(dir = root) {
    if (!dir.trim()) return;
    setBusy("scan");
    try {
      const list = await api.importScan(dir.trim(), Number(depth));
      setFound(list);
      setPicked(new Set(list.filter((r) => !r.added).map((r) => r.path)));
    } catch (e) {
      toast({ kind: "error", title: "Could not look in that folder", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  async function choose() {
    const d = await open({ directory: true, multiple: false, title: "Which folder holds your projects?", defaultPath: root || undefined });
    if (typeof d === "string") {
      setRoot(d);
      void scan(d);
    }
  }

  async function add() {
    setBusy("add");
    try {
      const r = await api.importAdd([...picked]);
      await loadProjects();
      void refreshAll();
      const n = r.added.length;
      toast({
        kind: r.failed.length ? "error" : "success",
        title: `Added ${n} project${n === 1 ? "" : "s"}${r.failed.length ? `, ${r.failed.length} failed` : ""}`,
        detail: r.failed.length ? r.failed.slice(0, 3).map(([p, e]) => `${p.split(/[\\/]/).pop()}: ${e}`).join("\n") : undefined,
      });
      onClose();
    } catch (e) {
      toast({ kind: "error", title: "Could not add the projects", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  const fresh = useMemo(() => (found ?? []).filter((r) => !r.added), [found]);
  const toggle = (path: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  const all = fresh.length > 0 && fresh.every((r) => picked.has(r.path));

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Import projects from a folder"
      width={640}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={picked.size === 0 || busy !== null} onClick={() => void add()}>
            {busy === "add" && <Spinner size={14} />} Add {picked.size || ""} project{picked.size === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-[var(--fg-muted)]">
          BluePhoenix looks for git repositories in the folder and its subfolders, detects what each one is, and adds the ones you pick with their commands.
        </p>
        <div className="flex gap-2">
          <input className="input" value={root} placeholder="/Users/you/Developer" onChange={(e) => setRoot(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void scan()} />
          <button className="btn btn-icon shrink-0" aria-label="Choose folder" onClick={() => void choose()}>
            <FolderOpen size={15} />
          </button>
          <button className="btn shrink-0" disabled={!root.trim() || busy !== null} onClick={() => void scan()}>
            {busy === "scan" ? <Spinner size={14} /> : <FolderSearch size={15} />} Look
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
          Look this deep:
          <Segmented value={depth} onChange={setDepth} options={[{ value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }]} />
          levels
        </div>

        {found &&
          (found.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-[var(--fg-faint)]">No git repositories in there. Try a different folder or look deeper.</p>
          ) : (
            <div className="rounded-xl border border-[var(--line)]">
              <label className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-xs text-[var(--fg-muted)]">
                <input type="checkbox" checked={all} disabled={fresh.length === 0} onChange={() => setPicked(all ? new Set() : new Set(fresh.map((r) => r.path)))} />
                {found.length} found{found.length - fresh.length ? ` · ${found.length - fresh.length} already in BluePhoenix` : ""}
              </label>
              <ul className="max-h-[40vh] overflow-y-auto">
                {found.map((r) => (
                  <li key={r.path}>
                    <label className={`flex items-start gap-2.5 px-3 py-1.5 text-[13px] ${r.added ? "opacity-50" : "cursor-pointer hover:bg-[var(--hover)]"}`}>
                      <input type="checkbox" className="mt-1" disabled={r.added} checked={r.added || picked.has(r.path)} onChange={() => toggle(r.path)} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate font-medium">{r.name}</span>
                          <span className="shrink-0 text-[11px] text-[var(--fg-faint)]">{r.added ? "already added" : r.kind}</span>
                        </span>
                        <span className="block truncate text-xs text-[var(--fg-faint)]">{r.path}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </Modal>
  );
}
