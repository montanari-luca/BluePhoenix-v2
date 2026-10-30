import { useMemo, useState } from "react";
import type { ProjectSummary } from "../lib/types";

/** Checkbox list for choosing several projects. */
export function ProjectMultiSelect({
  projects,
  value,
  onChange,
}: {
  projects: ProjectSummary[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const picked = useMemo(() => new Set(value), [value]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.kind.toLowerCase().includes(q));
  }, [projects, query]);

  if (projects.length === 0) {
    return <p className="text-xs text-[var(--fg-faint)]">No projects with a folder yet. Add one from the Dashboard first.</p>;
  }

  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((x) => x !== id));

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <input className="input !h-8 flex-1" placeholder="Filter projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn btn-sm" onClick={() => onChange(projects.map((p) => p.id))}>
          Select all
        </button>
        <button type="button" className="btn btn-sm" onClick={() => onChange([])} disabled={value.length === 0}>
          Clear
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto rounded-xl border border-[var(--line)] p-1">
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-[var(--fg-faint)]">No matching projects.</p>
        ) : (
          shown.map((p) => (
            <label key={p.id} className="row-hover flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5">
              <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
              <span className="shrink-0 text-xs text-[var(--fg-faint)]">{p.kind}</span>
            </label>
          ))
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--fg-faint)]">
        {value.length} project{value.length === 1 ? "" : "s"} selected
      </p>
    </div>
  );
}
