import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, GitCommitHorizontal, GitFork, Workflow, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { logError } from "../lib/store";
import type { Activity } from "../lib/types";
import { goToProject } from "./projectMenu";
import { Segmented, Spinner } from "./ui";

type Filter = "all" | Activity["kind"];

const ICON: Record<Activity["kind"], ReactNode> = {
  commit: <GitCommitHorizontal size={15} />,
  fork: <GitFork size={15} />,
  automation: <Workflow size={15} />,
  todo: <CheckCircle2 size={15} />,
};

const TONE: Record<string, string> = { ok: "var(--ok)", failed: "var(--bad)", warn: "var(--warn)" };

const PAGE = 60;

/** What happened across all projects, newest first: commits, automation runs, fork updates, finished to-dos. */
export function ActivityPanel({ onClose }: { onClose: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);

  const kinds = filter === "all" ? undefined : [filter];
  const load = useCallback(async () => {
    const list = await api.activityFeed({ limit: PAGE, kinds }).catch(logError("activity feed", [] as Activity[]));
    setItems(list);
    setMore(list.length === PAGE);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    void load();
    const subs = ["activity-changed", "automation-finished", "fork-sync-finished"].map((ev) => listen(ev, () => void load()));
    return () => subs.forEach((p) => void p.then((f) => f()));
  }, [load]);

  async function older() {
    const last = items[items.length - 1];
    if (!last) return;
    const next = await api.activityFeed({ limit: PAGE, before: last.ts, kinds }).catch(logError("activity feed", [] as Activity[]));
    setItems((cur) => [...cur, ...next.filter((n) => !cur.some((c) => c.id === n.id))]);
    setMore(next.length === PAGE);
  }

  // Group by day for scanning.
  const groups: { day: string; items: Activity[] }[] = [];
  for (const a of items) {
    const day = new Date(a.ts).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const g = groups[groups.length - 1];
    if (g?.day === day) g.items.push(a);
    else groups.push({ day, items: [a] });
  }

  return (
    <aside className="glass flex h-full w-[340px] shrink-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <h2 className="text-[15px] font-semibold">Activity</h2>
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Close activity" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="px-4 pb-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "commit", label: "Commits" },
            { value: "automation", label: "Runs" },
            { value: "todo", label: "To-dos" },
            { value: "fork", label: "Forks" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <p className="px-2 py-8 text-center text-[13px] text-[var(--fg-faint)]">
            Nothing yet. Commits, automation runs, fork updates and finished to-dos show up here.
          </p>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.day}>
                <div className="label px-2 pt-3">{g.day}</div>
                <ul>
                  {g.items.map((a) => (
                    <li key={a.id}>
                      <button
                        className="row-hover flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left"
                        onClick={() => goToProject(a.projectId, a.kind === "commit" || a.kind === "fork" ? "git" : a.kind === "todo" ? "todos" : undefined)}
                      >
                        <span className="mt-0.5 shrink-0" style={{ color: (a.tone && TONE[a.tone]) || "var(--fg-muted)" }}>
                          {ICON[a.kind]}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-[13px]">{a.title}</span>
                          <span className="block truncate text-xs text-[var(--fg-faint)]">
                            {a.projectName}
                            {a.detail ? ` · ${a.detail}` : ""} · {timeAgo(a.ts)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {more && (
              <div className="flex justify-center pt-2">
                <button className="btn btn-sm btn-ghost" onClick={() => void older()}>
                  Show older
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
