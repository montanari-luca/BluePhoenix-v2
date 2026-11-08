import { Archive, ArchiveRestore, GitBranch, GitMerge, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { generateCommitMessage } from "../lib/ai";
import { gitAction } from "../lib/actions";
import { api, errMsg } from "../lib/api";
import { formatDateTime, timeAgo } from "../lib/format";
import { useStore } from "../lib/store";
import type { Branch, Change, Commit, Project } from "../lib/types";
import { CommitGraphCell, GRAPH_PALETTE, GRAPH_ROW_H, RefLabels, graphWidth } from "../components/CommitGraph";
import { ForkStatusCard } from "../components/ForkSync";
import { layoutGraph } from "../lib/graph";
import { Dropdown, Empty, Modal, Segmented, Spinner, useConfirm } from "../components/ui";

type View = "changes" | "branches" | "history" | "stashes";

function DiffText({ text }: { text: string }) {
  return (
    <pre className="selectable overflow-x-auto font-mono text-xs leading-relaxed">
      {text.split("\n").map((l, i) => {
        let color = "inherit";
        if (l.startsWith("+") && !l.startsWith("+++")) color = "var(--ok)";
        else if (l.startsWith("-") && !l.startsWith("---")) color = "var(--bad)";
        else if (l.startsWith("@@")) color = "var(--accent)";
        else if (/^(diff |index |--- |\+\+\+ )/.test(l)) color = "var(--fg-faint)";
        return (
          <div key={i} style={{ color }}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}

const LETTER: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type", U: "Conflict", "?": "Untracked" };

function isStaged(c: Change) {
  return !c.untracked && c.index !== "." && c.index !== "?";
}

export default function GitTab({ project: p }: { project: Project }) {
  const status = useStore((s) => s.statuses[p.id]);
  const refreshStatus = useStore((s) => s.refreshStatus);
  const toast = useStore((s) => s.toast);
  const [view, setView] = useState<View>("changes");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [log, setLog] = useState<Commit[]>([]);
  const [logLimit, setLogLimit] = useState(50);
  const [stashes, setStashes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ title: string; text: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const { confirm, node } = useConfirm();
  const graph = useMemo(() => layoutGraph(log, GRAPH_PALETTE.length), [log]);
  const remotes = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches]);

  const loadLists = useCallback(async () => {
    try {
      const [b, l, s] = await Promise.all([api.gitBranches(p.path), api.gitLog(p.path, logLimit), api.gitStashList(p.path)]);
      setBranches(b);
      setLog(l);
      setStashes(s);
    } catch {
      /* not a repo yet */
    }
  }, [p.path, logLimit]);

  useEffect(() => {
    void refreshStatus(p.id);
    void loadLists();
  }, [p.id, refreshStatus, loadLists]);

  async function act<T>(label: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    setWorking(label);
    try {
      const out = await fn();
      if (success || typeof out === "string") toast({ kind: "success", title: success ?? label, detail: typeof out === "string" ? out.slice(0, 400) : undefined });
      return out;
    } catch (e) {
      toast({ kind: "error", title: `${label} failed`, detail: errMsg(e) });
    } finally {
      setWorking(null);
      await refreshStatus(p.id);
      await loadLists();
    }
  }

  if (!status) return <div className="p-10 text-center"><Spinner size={22} /></div>;
  if (!status.isRepo) {
    return (
      <div className="glass">
        <Empty icon={<GitBranch size={32} />} title="Not a git repository">
          Initialise git in this folder to track changes, branches and history.
          <div className="mt-3">
            <button className="btn btn-primary" onClick={() => void act("git init", () => api.gitInit(p.path))}>Run git init</button>
          </div>
        </Empty>
      </div>
    );
  }

  const staged = status.changes.filter(isStaged);
  const hasConflicts = status.conflicted > 0;

  async function showDiff(c: Change) {
    try {
      const text = c.untracked
        ? "This file is new and untracked. Stage it to include it in the next commit."
        : (await api.gitDiff(p.path, isStaged(c) && c.worktree === ".", c.path)) || (await api.gitDiff(p.path, true, c.path)) || "No textual changes.";
      setDiff({ title: c.path, text });
    } catch (e) {
      toast({ kind: "error", title: "Could not load the diff", detail: errMsg(e) });
    }
  }

  async function aiMessage() {
    setWorking("Writing commit message");
    try {
      setMessage(await generateCommitMessage(p.path));
    } catch (e) {
      toast({ kind: "error", title: "Could not generate a message", detail: errMsg(e) });
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ForkStatusCard project={p} />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "changes", label: `Changes${status.changes.length ? ` (${status.changes.length})` : ""}` },
            { value: "branches", label: "Branches" },
            { value: "history", label: "History" },
            { value: "stashes", label: `Stashes${stashes.length ? ` (${stashes.length})` : ""}` },
          ]}
        />
        {working && (
          <span className="flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
            <Spinner size={14} /> {working}…
          </span>
        )}
        <div className="flex-1" />
        {hasConflicts && (
          <button className="btn btn-danger" onClick={() => void act("Abort merge", () => api.gitMergeAbort(p.path))}>
            Abort merge
          </button>
        )}
      </div>

      {view === "changes" && (
        <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
          <div className="glass overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-2.5">
              <span className="text-[13px] font-semibold">Working tree</span>
              <div className="flex gap-2">
                <button className="btn btn-sm" onClick={() => void act("Stage all", () => api.gitStage(p.path, []), "Staged everything")} disabled={status.changes.length === 0}>
                  Stage all
                </button>
                <button className="btn btn-sm" onClick={() => void act("Unstage all", () => api.gitUnstage(p.path, []), "Unstaged everything")} disabled={staged.length === 0}>
                  Unstage all
                </button>
              </div>
            </div>
            {status.changes.length === 0 ? (
              <Empty icon={<GitBranch size={28} />} title="Working tree clean">Nothing to commit.</Empty>
            ) : (
              <ul className="max-h-[52vh] overflow-y-auto p-1.5">
                {status.changes.map((c) => (
                  <li key={c.path} className="row-hover flex items-center gap-2.5 rounded-lg px-2.5 py-1.5">
                    <input
                      type="checkbox"
                      checked={isStaged(c)}
                      aria-label={`Stage ${c.path}`}
                      onChange={(e) =>
                        void act(e.target.checked ? "Stage" : "Unstage", () => (e.target.checked ? api.gitStage(p.path, [c.path]) : api.gitUnstage(p.path, [c.path])), `${e.target.checked ? "Staged" : "Unstaged"} ${c.path}`)
                      }
                    />
                    <span
                      className="w-5 text-center font-mono text-xs font-bold"
                      title={LETTER[c.conflicted ? "U" : c.untracked ? "?" : c.index !== "." ? c.index : c.worktree]}
                      style={{ color: c.conflicted ? "var(--bad)" : c.untracked ? "var(--fg-faint)" : c.worktree === "D" || c.index === "D" ? "var(--bad)" : c.index === "A" ? "var(--ok)" : "var(--warn)" }}
                    >
                      {c.conflicted ? "U" : c.untracked ? "?" : c.index !== "." ? c.index : c.worktree}
                    </span>
                    <button className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-xs" onClick={() => void showDiff(c)} title="View diff">
                      {c.path}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="glass flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold">Commit {staged.length > 0 && <span className="font-normal text-[var(--fg-faint)]">· {staged.length} staged</span>}</h3>
              <button className="btn btn-sm" onClick={aiMessage} disabled={!!working || status.changes.length === 0}>
                <Sparkles size={13} /> Generate
              </button>
            </div>
            <textarea className="input" rows={6} placeholder="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} />
            <div className="flex gap-2">
              <button
                className="btn btn-primary flex-1"
                disabled={!message.trim() || staged.length === 0 || !!working}
                onClick={async () => {
                  const r = await act("Commit", () => api.gitCommit(p.path, message));
                  if (r !== undefined) setMessage("");
                }}
              >
                Commit
              </button>
              <button
                className="btn flex-1"
                disabled={!message.trim() || staged.length === 0 || !!working}
                onClick={async () => {
                  const r = await act("Commit", () => api.gitCommit(p.path, message));
                  if (r !== undefined) {
                    setMessage("");
                    await gitAction(p, "push");
                  }
                }}
              >
                Commit &amp; push
              </button>
            </div>
            {staged.length === 0 && status.changes.length > 0 && <p className="text-xs text-[var(--fg-faint)]">Tick files on the left to stage them.</p>}
          </div>
        </div>
      )}

      {view === "branches" && (
        <div className="glass overflow-hidden">
          <div className="flex gap-2 border-b border-[var(--line)] p-3">
            <input className="input" placeholder="New branch name (from the current branch)" value={newBranch} onChange={(e) => setNewBranch(e.target.value.replace(/\s+/g, "-"))} />
            <button
              className="btn btn-primary shrink-0"
              disabled={!newBranch.trim()}
              onClick={async () => {
                const r = await act(`Create ${newBranch}`, () => api.gitCreateBranch(p.path, newBranch.trim()));
                if (r !== undefined) setNewBranch("");
              }}
            >
              <Plus size={14} /> Create &amp; switch
            </button>
          </div>
          <ul className="max-h-[56vh] overflow-y-auto p-1.5">
            {branches.map((b) => (
              <li key={(b.remote ? "r:" : "l:") + b.name} className="row-hover flex items-center gap-3 rounded-lg px-3 py-2">
                <GitBranch size={15} className={b.current ? "text-[var(--accent)]" : "text-[var(--fg-faint)]"} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`truncate font-mono text-[13px] ${b.current ? "font-bold" : ""}`}>{b.name}</span>
                    {b.current && <span className="pill" style={{ "--pill": "var(--accent)" } as React.CSSProperties}>current</span>}
                    {b.remote && <span className="pill">remote</span>}
                  </div>
                  <div className="truncate text-xs text-[var(--fg-faint)]">
                    {b.subject} {b.lastCommitTs ? `· ${timeAgo(b.lastCommitTs)}` : ""}
                  </div>
                </div>
                {!b.current && (
                  <div className="flex gap-1.5">
                    <button className="btn btn-sm" onClick={() => void act(`Switch to ${b.name}`, () => api.gitCheckout(p.path, b.name, b.remote))}>
                      Switch
                    </button>
                    {!b.remote && (
                      <Dropdown
                        items={[
                          { label: `Merge ${b.name} into ${status.branch ?? "HEAD"}`, icon: <GitMerge size={14} />, onClick: () => void act(`Merge ${b.name}`, () => api.gitMerge(p.path, b.name)) },
                          {
                            label: "Delete branch",
                            icon: <Trash2 size={14} />,
                            danger: true,
                            onClick: async () => {
                              if (await confirm(`Delete the local branch “${b.name}”? Unmerged work on it will be lost.`)) void act(`Delete ${b.name}`, () => api.gitDeleteBranch(p.path, b.name, true));
                            },
                          },
                        ]}
                        width={260}
                      >
                        <button className="btn btn-sm">More</button>
                      </Dropdown>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view === "history" && (
        <div className="glass overflow-hidden">
          {log.length === 0 ? (
            <Empty icon={<GitBranch size={28} />} title="No commits yet" />
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto p-1.5">
              {log.map((c, i) => (
                <li key={c.hash}>
                  <button
                    className="row-hover flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left"
                    style={{ height: GRAPH_ROW_H }}
                    onClick={async () => setDiff({ title: `${c.short} — ${c.subject}`, text: await api.gitShow(p.path, c.hash).catch((e) => errMsg(e)) })}
                  >
                    <CommitGraphCell row={graph.rows[i]} width={graphWidth(graph.width)} merge={c.parents.length > 1} />
                    <code className="font-mono text-xs text-[var(--accent)]">{c.short}</code>
                    <RefLabels refs={c.refs} remotes={remotes} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{c.subject}</span>
                    <span className="shrink-0 text-xs text-[var(--fg-faint)]">{c.author} · {formatDateTime(c.ts)}</span>
                  </button>
                </li>
              ))}
              {log.length >= logLimit && (
                <li className="p-2 text-center">
                  <button className="btn btn-sm" onClick={() => setLogLimit((n) => n + 100)}>Load more</button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {view === "stashes" && (
        <div className="glass p-4">
          <div className="mb-3 flex gap-2">
            <button className="btn" onClick={() => void act("Stash", () => api.gitStash(p.path))} disabled={status.changes.length === 0}>
              <Archive size={14} /> Stash changes
            </button>
            <button className="btn" onClick={() => void act("Apply last stash", () => api.gitStashApply(p.path))} disabled={stashes.length === 0}>
              <ArchiveRestore size={14} /> Apply last stash
            </button>
          </div>
          {stashes.length === 0 ? (
            <p className="text-[13px] text-[var(--fg-faint)]">No stashes.</p>
          ) : (
            <ul className="selectable font-mono text-xs">
              {stashes.map((s) => (
                <li key={s} className="py-1.5">{s}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Modal open={!!diff} onClose={() => setDiff(null)} title={diff?.title ?? ""} width={900}>
        {diff && <DiffText text={diff.text} />}
      </Modal>
      {node}
    </div>
  );
}
