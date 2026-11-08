import { Archive, ArchiveRestore, ArrowDownToLine, ArrowUpFromLine, Clock, FileText, GitBranch, GitCommit, ListTodo, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { gitAction, hasFolder } from "../lib/actions";
import { api } from "../lib/api";
import { branchState, formatDateTime, formatMinutes, timeAgo, toneColor } from "../lib/format";
import { useStore, logError } from "../lib/store";
import type { Commit, ProjectSummary, TimeEntry } from "../lib/types";
import { Pill, Spinner } from "../components/ui";

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="glass p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--fg-muted)]">
        {icon} {label}
      </div>
      <div className="mt-1.5 text-[22px] leading-none font-bold">{value}</div>
      {sub && <div className="mt-1 text-xs text-[var(--fg-faint)]">{sub}</div>}
    </div>
  );
}

export default function OverviewTab({ project: p }: { project: ProjectSummary }) {
  const status = useStore((s) => s.statuses[p.id]);
  const busy = useStore((s) => s.busy[p.id]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [time, setTime] = useState<TimeEntry[]>([]);
  const [files, setFiles] = useState(0);
  const folder = hasFolder(p);
  const state = branchState(status);

  useEffect(() => {
    api.time(p.id).then((t) => setTime(t.slice(0, 5))).catch(logError("load time"));
    api.filesCount(p.id).then(setFiles).catch(logError("count files"));
  }, [p.id, p.totalMinutes]);

  useEffect(() => {
    if (folder && status?.isRepo) api.gitLog(p.path, 6).then(setCommits).catch((e) => setCommits(logError("recent commits", [])(e)));
  }, [p.path, folder, status?.isRepo, status?.head]);

  const act = (a: Parameters<typeof gitAction>[1]) => () => void gitAction(p, a);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <Stat icon={<Clock size={14} />} label="Time tracked" value={formatMinutes(p.totalMinutes)} sub={`${time.length ? "Last: " + timeAgo(time[0].loggedAt) : "Nothing logged yet"}`} />
        <Stat icon={<ListTodo size={14} />} label="Open to-dos" value={String(p.openTodos)} sub={`${p.doneTodos} completed`} />
        <Stat icon={<FileText size={14} />} label="Files indexed" value={files ? files.toLocaleString() : "—"} sub={folder ? "Open the Files tab to refresh" : "No folder"} />
        <Stat icon={<GitCommit size={14} />} label="Last commit" value={status?.lastCommitTs ? timeAgo(status.lastCommitTs) : "—"} sub={status?.lastCommitSubject ?? undefined} />
      </div>

      {folder && (
        <div className="glass p-4">
          <div className="flex flex-wrap items-center gap-3">
            <GitBranch size={17} className="text-[var(--fg-muted)]" />
            {status?.isRepo ? (
              <>
                <span className="font-mono text-[15px] font-semibold">{status.branch ?? `detached @ ${status.head}`}</span>
                {busy ? (
                  <Pill color="var(--info)">
                    <Spinner size={11} /> {busy}
                  </Pill>
                ) : (
                  <Pill color={toneColor(state.tone)}>{state.label}</Pill>
                )}
                {status.upstream && <span className="text-xs text-[var(--fg-faint)]">tracking {status.upstream}</span>}
                {status.stashCount > 0 && <Pill>{status.stashCount} stash{status.stashCount > 1 ? "es" : ""}</Pill>}
              </>
            ) : status ? (
              <>
                <span className="text-[13px] text-[var(--fg-muted)]">This folder is not a git repository.</span>
                <button className="btn btn-sm" onClick={() => void api.gitInit(p.path).then(() => useStore.getState().refreshStatus(p.id))}>
                  git init
                </button>
              </>
            ) : (
              <Spinner />
            )}
          </div>
          {status?.isRepo && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn" onClick={act("fetch")} disabled={!!busy}><RefreshCw size={14} /> Fetch</button>
              <button className="btn" onClick={act("pull")} disabled={!!busy}><ArrowDownToLine size={14} /> Pull</button>
              <button className="btn" onClick={act("push")} disabled={!!busy}><ArrowUpFromLine size={14} /> Push</button>
              <button className="btn" onClick={act("stash")} disabled={!!busy}><Archive size={14} /> Stash</button>
              <button className="btn" onClick={act("stashApply")} disabled={!!busy}><ArchiveRestore size={14} /> Apply last stash</button>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="glass p-4">
          <h3 className="mb-2 text-[13px] font-semibold">Recent commits</h3>
          {commits.length === 0 ? (
            <p className="text-[13px] text-[var(--fg-faint)]">{status?.isRepo ? "No commits yet." : "No git history to show."}</p>
          ) : (
            <ul className="flex flex-col">
              {commits.map((c) => (
                <li key={c.hash} className="flex items-baseline gap-2 py-1.5 text-[13px]">
                  <code className="font-mono text-xs text-[var(--accent)]">{c.short}</code>
                  <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                  <span className="shrink-0 text-xs text-[var(--fg-faint)]">{timeAgo(c.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="glass p-4">
          <h3 className="mb-2 text-[13px] font-semibold">Recent time entries</h3>
          {time.length === 0 ? (
            <p className="text-[13px] text-[var(--fg-faint)]">Log time from the Time tab.</p>
          ) : (
            <ul className="flex flex-col">
              {time.map((t) => (
                <li key={t.id} className="flex items-baseline gap-2 py-1.5 text-[13px]">
                  <span className="w-14 font-semibold">{formatMinutes(t.minutes)}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--fg-muted)]">{t.note ?? ""}</span>
                  <span className="shrink-0 text-xs text-[var(--fg-faint)]">{formatDateTime(t.loggedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {folder && (
        <p className="selectable truncate text-xs text-[var(--fg-faint)]" title={p.path}>
          {p.path}
        </p>
      )}
    </div>
  );
}
