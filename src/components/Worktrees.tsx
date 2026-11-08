import { open } from "@tauri-apps/plugin-dialog";
import { Code2, FolderOpen, FolderTree, Lock, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { openEditor, openTerminal } from "../lib/actions";
import { api, errMsg } from "../lib/api";
import { useGitChanged } from "../lib/gitEvents";
import { logError, useStore } from "../lib/store";
import type { Branch, Project, Worktree } from "../lib/types";
import { Field, Modal, Pill, Segmented, Spinner, useConfirm } from "./ui";

const parentOf = (path: string) => path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
const sep = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
const slug = (s: string) => s.replace(/^origin\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

/** The folder BluePhoenix suggests for a branch: a sibling of the repository, `<repo>-<branch>`. */
export function suggestedDir(repoPath: string, branch: string) {
  const s = sep(repoPath);
  return `${parentOf(repoPath)}${s}${baseName(repoPath)}-${slug(branch) || "worktree"}`;
}

/** Git tab view: the repository's worktrees, with open / remove, and a form to add one. */
export function WorktreesView({ project: p }: { project: Project }) {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<Worktree[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, node } = useConfirm();

  const load = useCallback(async () => {
    const [w, b] = await Promise.all([
      api.gitWorktrees(p.path).catch(logError("list worktrees", [] as Worktree[])),
      api.gitBranches(p.path).catch(logError("list branches", [] as Branch[])),
    ]);
    setList(w);
    setBranches(b);
  }, [p.path]);
  useEffect(() => void load(), [load]);
  useGitChanged(p.id, () => void load());

  // Branches already checked out somewhere cannot get a second worktree.
  const used = useMemo(() => new Set((list ?? []).map((w) => w.branch).filter(Boolean)), [list]);
  const available = branches.filter((b) => !used.has(b.remote ? b.name.replace(/^[^/]+\//, "") : b.name) && !b.name.endsWith("/HEAD"));

  useEffect(() => {
    if (!dirTouched) setDir(branch ? suggestedDir(p.path, branch) : "");
  }, [branch, dirTouched, p.path]);

  function startAdd() {
    setMode("new");
    setBranch("");
    setDir("");
    setDirTouched(false);
    setAdding(true);
  }

  async function chooseDir() {
    const d = await open({ directory: true, multiple: false, title: "Where should the worktree go?", defaultPath: parentOf(p.path) });
    if (typeof d === "string") {
      setDir(`${d}${sep(d)}${baseName(p.path)}-${slug(branch) || "worktree"}`);
      setDirTouched(true);
    }
  }

  async function add() {
    setBusy("add");
    try {
      // A remote branch ("origin/x") is checked out as a local tracking branch "x".
      const name = mode === "existing" ? branch.replace(/^origin\//, "") : branch.trim();
      await api.gitWorktreeAdd(p.path, dir.trim(), name, mode === "new");
      setAdding(false);
      toast({ kind: "success", title: `Worktree for ${name} created`, detail: dir });
      await load();
    } catch (e) {
      toast({ kind: "error", title: "Could not create the worktree", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(w: Worktree) {
    if (!(await confirm(`Remove the worktree at ${w.path}? The folder is deleted; the branch ${w.branch ?? ""} is kept.`))) return;
    setBusy(w.path);
    try {
      await api.gitWorktreeRemove(p.path, w.path, false);
    } catch (e) {
      const msg = errMsg(e);
      if (msg.includes("uncommitted changes") && (await confirm(`${msg}`))) {
        await api.gitWorktreeRemove(p.path, w.path, true).catch((e2) => toast({ kind: "error", title: "Could not remove it", detail: errMsg(e2) }));
      } else if (!msg.includes("uncommitted changes")) {
        toast({ kind: "error", title: "Could not remove it", detail: msg });
      }
    } finally {
      setBusy(null);
      await load();
    }
  }

  const at = (w: Worktree): Project => ({ ...p, path: w.path });

  return (
    <div className="glass p-4">
      <div className="mb-3 flex items-center gap-3">
        <p className="flex-1 text-[13px] text-[var(--fg-muted)]">
          Worktrees let you have several branches checked out at once, each in its own folder. Handy for a hotfix while a feature is half done.
        </p>
        <button className="btn" onClick={startAdd}>
          <Plus size={14} /> New worktree
        </button>
      </div>
      {list === null ? (
        <Spinner />
      ) : (
        <ul className="flex flex-col">
          {list.map((w) => (
            <li key={w.path} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--hover)]">
              <FolderTree size={15} className="shrink-0 text-[var(--fg-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-mono">{w.branch ?? (w.detached ? `detached @ ${w.head?.slice(0, 7)}` : "bare")}</span>
                  {w.main && <Pill>main folder</Pill>}
                  {w.locked && (
                    <Pill color="var(--warn)">
                      <Lock size={10} /> locked
                    </Pill>
                  )}
                  {w.prunable && <Pill color="var(--bad)">folder missing</Pill>}
                </div>
                <div className="selectable truncate text-xs text-[var(--fg-faint)]">{w.path}</div>
              </div>
              {busy === w.path ? (
                <Spinner size={14} />
              ) : (
                <div className="flex shrink-0 gap-1">
                  <button className="btn btn-ghost btn-icon btn-sm" title="Open in editor" aria-label="Open in editor" disabled={w.prunable} onClick={() => void openEditor(at(w))}>
                    <Code2 size={14} />
                  </button>
                  <button className="btn btn-ghost btn-icon btn-sm" title="Open in terminal" aria-label="Open in terminal" disabled={w.prunable} onClick={() => void openTerminal(at(w), "system")}>
                    <SquareTerminal size={14} />
                  </button>
                  <button className="btn btn-ghost btn-icon btn-sm" title="Reveal folder" aria-label="Reveal folder" disabled={w.prunable} onClick={() => void api.reveal(w.path)}>
                    <FolderOpen size={14} />
                  </button>
                  {!w.main && (
                    <button className="btn btn-ghost btn-icon btn-sm" title="Remove worktree" aria-label="Remove worktree" onClick={() => void remove(w)}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="New worktree"
        width={520}
        footer={
          <>
            <button className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!branch.trim() || !dir.trim() || busy === "add"} onClick={() => void add()}>
              {busy === "add" ? <Spinner size={14} /> : null} Create worktree
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m);
              setBranch("");
            }}
            options={[
              { value: "new", label: "New branch" },
              { value: "existing", label: "Existing branch" },
            ]}
          />
          {mode === "new" ? (
            <Field label="Branch name" hint="Starts from the commit you are on now.">
              <input className="input font-mono" autoFocus value={branch} placeholder="hotfix/login" onChange={(e) => setBranch(e.target.value.replace(/\s/g, "-"))} />
            </Field>
          ) : (
            <Field label="Branch">
              <select className="input font-mono" value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">Choose a branch…</option>
                {available.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Folder">
            <div className="flex gap-2">
              <input
                className="input font-mono text-xs"
                value={dir}
                onChange={(e) => {
                  setDir(e.target.value);
                  setDirTouched(true);
                }}
              />
              <button className="btn btn-icon shrink-0" aria-label="Choose folder" onClick={() => void chooseDir()}>
                <FolderOpen size={15} />
              </button>
            </div>
          </Field>
        </div>
      </Modal>
      {node}
    </div>
  );
}
