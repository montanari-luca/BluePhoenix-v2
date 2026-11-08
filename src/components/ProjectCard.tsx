import { CalendarClock, Clock, Code2, EllipsisVertical, GitBranch, GitFork, ListTodo, Play, Star } from "lucide-react";
import { useEffect, useRef } from "react";
import { defaultCommand, defaultEditorId, editorName, hasFolder, openEditor, runCommand, toggleFavorite } from "../lib/actions";
import { forkLabel, forkTone } from "../lib/fork";
import { branchState, formatMinutes, timeAgo, toneColor } from "../lib/format";
import { setCardVisible, useStore } from "../lib/store";
import type { ProjectSummary } from "../lib/types";
import { buildEditorMenu, buildProjectMenu, goToProject } from "./projectMenu";
import { GithubBadges } from "./PullRequests";
import { Dropdown, type MenuItem, Pill, Spinner, SplitButton } from "./ui";

export function ProjectCard({ project: p, onRemove, onEdit }: { project: ProjectSummary; onRemove: () => void; onEdit: () => void }) {
  const status = useStore((s) => s.statuses[p.id]);
  const cmds = useStore((s) => s.commands[p.id]);
  const busy = useStore((s) => s.busy[p.id]);
  const fork = useStore((s) => s.forks[p.id]);
  const github = useStore((s) => s.github[p.id]);
  const settings = useStore((s) => s.settings);
  const editors = useStore((s) => s.editors);
  const loadCommands = useStore((s) => s.loadCommands);
  const setSetting = useStore((s) => s.setSetting);

  useEffect(() => {
    if (!cmds) void loadCommands(p.id);
  }, [p.id, cmds, loadCommands]);

  // Cards on screen get their git status refreshed first.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setCardVisible(p.id, e.isIntersecting));
    io.observe(el);
    return () => {
      io.disconnect();
      setCardVisible(p.id, false);
    };
  }, [p.id]);

  const folder = hasFolder(p);
  const state = branchState(status);
  const color = toneColor(state.tone);
  const editorId = defaultEditorId(p);
  void editors;
  const list = cmds ?? [];
  const main = defaultCommand(p, list);
  const runIn = settings.runIn ?? "embedded";

  const commandItems: MenuItem[] = [
    { label: "Run command", header: true },
    ...list.map((c) => ({
      label: c.label,
      icon: <Play size={14} />,
      checked: c.id === main?.id,
      onClick: () => void runCommand(p, c),
    })),
    { separator: true },
    { label: "Run in", header: true },
    { label: "Embedded terminal", checked: runIn === "embedded", onClick: () => void setSetting("runIn", "embedded") },
    { label: "System terminal", checked: runIn === "system", onClick: () => void setSetting("runIn", "system") },
    { separator: true },
    { label: "Manage commands…", onClick: () => goToProject(p.id, "commands") },
  ];

  return (
    <div
      ref={cardRef}
      className="glass group relative flex cursor-pointer flex-col transition-transform hover:-translate-y-0.5"
      onClick={() => goToProject(p.id)}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && goToProject(p.id)}
    >
      {/* header */}
      <div className="flex items-start gap-2 p-4 pb-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-[15px] font-semibold">{p.name}</h3>
            <span className="shrink-0 text-[11px] text-[var(--fg-faint)]">{p.kind}</span>
          </div>
          {p.description && <p className="mt-1 line-clamp-2 text-[13px] text-[var(--fg-muted)]">{p.description}</p>}
        </div>
        <button
          className="btn btn-ghost btn-icon btn-sm"
          aria-label={p.favorite ? "Remove from favorites" : "Add to favorites"}
          onClick={(e) => {
            e.stopPropagation();
            void toggleFavorite(p);
          }}
        >
          <Star size={16} fill={p.favorite ? "#f5b301" : "none"} color={p.favorite ? "#f5b301" : "currentColor"} />
        </button>
        <Dropdown items={buildProjectMenu(p, { onRemove, onEdit })}>
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Project menu">
            <EllipsisVertical size={16} />
          </button>
        </Dropdown>
      </div>

      {/* branch */}
      <div className="flex items-center gap-2 px-4 pt-3">
        {folder ? (
          <>
            <GitBranch size={15} className="shrink-0 text-[var(--fg-muted)]" />
            <span className="truncate font-mono text-[13px]">
              {status?.isRepo === false ? "—" : (status?.branch ?? (status?.detached ? `detached @ ${status.head}` : "…"))}
            </span>
            {busy ? (
              <Pill color="var(--info)">
                <Spinner size={11} /> {busy}
              </Pill>
            ) : (
              <Pill color={color} title={status?.lastCommitSubject ?? undefined}>
                {state.label}
              </Pill>
            )}
          </>
        ) : (
          <Pill>No folder · tracking only</Pill>
        )}
      </div>

      {/* facts */}
      <ul className="mt-3 flex flex-col gap-1.5 px-4 text-[13px] text-[var(--fg-muted)]">
        <li className="flex items-center gap-2">
          <Clock size={14} /> <span>{formatMinutes(p.totalMinutes)} tracked</span>
        </li>
        <li className="flex items-center gap-2">
          <ListTodo size={14} />
          <span>
            {p.openTodos} open to-do{p.openTodos === 1 ? "" : "s"}
            {p.doneTodos > 0 && <span className="text-[var(--fg-faint)]"> · {p.doneTodos} done</span>}
          </span>
        </li>
        <GithubBadges status={github} />
        {fork?.isFork && (
          <li className="flex items-center gap-2" title={fork.message ?? undefined}>
            <GitFork size={14} />
            <span className="truncate" style={{ color: fork.status ? toneColor(forkTone(fork.status)) : undefined }}>
              {forkLabel(fork)}
            </span>
          </li>
        )}
        <li className="flex items-center gap-2">
          <CalendarClock size={14} />
          <span>Updated {timeAgo(Math.max(p.lastActivity, status?.lastCommitTs ?? 0))}</span>
        </li>
      </ul>

      <div className="divider mx-4 mt-4" />

      {/* actions */}
      <div className="flex items-center gap-2 p-3 px-4" onClick={(e) => e.stopPropagation()}>
        <SplitButton
          icon={<Code2 size={14} />}
          label={`Open in ${editorName(editorId)}`}
          onClick={() => void openEditor(p)}
          items={buildEditorMenu(p)}
          disabled={!folder}
        />
        <div className="flex-1" />
        <SplitButton
          primary
          icon={<Play size={13} />}
          label={main ? main.label : "No commands"}
          onClick={() => main && void runCommand(p, main)}
          items={commandItems}
          disabled={!folder || !main}
          title={main?.command}
        />
      </div>
    </div>
  );
}
