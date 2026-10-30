import { Clock, MoreHorizontal, Pencil, Play, Target, Trash2, Zap } from "lucide-react";
import { describeTargets, describeWhen, requisiteChips } from "../lib/automations";
import { timeAgo } from "../lib/format";
import type { Automation, ProjectSummary } from "../lib/types";
import { Dropdown, Pill, Spinner, Toggle } from "./ui";

const STATUS: Record<string, { label: string; color: string }> = {
  ok: { label: "Succeeded", color: "var(--ok)" },
  failed: { label: "Failed", color: "var(--bad)" },
  timeout: { label: "Timed out", color: "var(--warn)" },
};

export function AutomationCard({
  automation: a,
  projects,
  running,
  onRun,
  onEdit,
  onRemove,
  onToggle,
}: {
  automation: Automation;
  projects: ProjectSummary[];
  running: boolean;
  onRun: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const chips = requisiteChips(a);
  const status = a.lastStatus ? STATUS[a.lastStatus] : null;
  const firstLine = a.commands.trim().split("\n")[0];
  return (
    <div
      className="glass group relative flex cursor-pointer flex-col p-4 transition-transform hover:-translate-y-0.5"
      style={a.enabled ? undefined : { opacity: 0.7 }}
      onClick={onEdit}
    >
      <div className="flex items-start gap-2.5">
        <Zap size={16} className="mt-1 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold">{a.name}</h3>
          {a.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-[var(--fg-muted)]">{a.description}</p>}
        </div>
        <span onClick={(e) => e.stopPropagation()}>
          <Toggle checked={a.enabled} onChange={onToggle} label={a.enabled ? "Disable automation" : "Enable automation"} />
        </span>
        <Dropdown
          width={190}
          items={[
            { label: "Run now", icon: <Play size={15} />, onClick: onRun, disabled: running },
            { label: "Edit…", icon: <Pencil size={15} />, onClick: onEdit },
            { separator: true },
            { label: "Remove", icon: <Trash2 size={15} />, onClick: onRemove, danger: true },
          ]}
        >
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="More">
            <MoreHorizontal size={16} />
          </button>
        </Dropdown>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Pill>
          <Clock size={12} /> {describeWhen(a)}
        </Pill>
        <Pill>
          <Target size={12} /> {describeTargets(a, projects)}
        </Pill>
        {chips.map((c) => (
          <Pill key={c}>{c}</Pill>
        ))}
        {a.notify !== "none" && <Pill>{a.notify === "before" ? `Alert ${a.notifyBeforeMin} min before` : "Alert on run"}</Pill>}
      </div>

      <code className="mt-3 block truncate rounded-lg bg-[var(--hover)] px-2.5 py-1.5 font-mono text-xs text-[var(--fg-muted)]" title={a.commands}>
        {firstLine}
      </code>

      <div className="divider my-3" />
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--fg-muted)]">
          {status ? (
            <>
              <span style={{ color: status.color }}>● {status.label}</span> · {timeAgo(a.lastRun)}
            </>
          ) : (
            "Never run"
          )}
        </span>
        <button className="btn btn-sm" onClick={onRun} disabled={running}>
          {running ? <Spinner size={13} /> : <Play size={13} />} Run now
        </button>
      </div>
    </div>
  );
}
