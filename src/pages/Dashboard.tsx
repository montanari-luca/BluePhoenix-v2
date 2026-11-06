import { FolderPlus, Search, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { removeProject } from "../lib/actions";
import { ProjectCard } from "../components/ProjectCard";
import { NewProjectDialog } from "../components/NewProjectDialog";
import { ProjectDialog } from "../components/ProjectDialog";
import { Empty, Segmented, useConfirm } from "../components/ui";
import { Logo } from "../components/TitleBar";
import { useStore } from "../lib/store";
import type { Project } from "../lib/types";

export default function Dashboard() {
  const projects = useStore((s) => s.projects);
  const ready = useStore((s) => s.ready);
  const refreshAll = useStore((s) => s.refreshAllStatuses);
  const addOpen = useStore((s) => s.addProjectOpen);
  const setAdd = useStore((s) => s.setAddProject);
  const newOpen = useStore((s) => s.newProjectOpen);
  const setNew = useStore((s) => s.setNewProject);
  const [editing, setEditing] = useState<Project | null>(null);
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const [query, setQuery] = useState("");
  const { confirm, node } = useConfirm();

  useEffect(() => {
    const onFocus = () => void refreshAll();
    window.addEventListener("focus", onFocus);
    const t = setInterval(onFocus, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
  }, [refreshAll]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter(
      (p) =>
        (filter === "all" || p.favorite) &&
        (!q || p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q) || p.kind.toLowerCase().includes(q)),
    );
  }, [projects, filter, query]);

  const askRemove = async (p: Project) => {
    if (await confirm(`Remove “${p.name}” from BluePhoenix? Your files on disk are not touched.`)) await removeProject(p);
  };

  if (!ready) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 pt-1 pb-4">
        <div className="mr-auto">
          <h1 className="text-[22px] font-bold tracking-tight">Projects</h1>
          <p className="text-[13px] text-[var(--fg-muted)]">
            {projects.length === 0 ? "Nothing here yet" : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--fg-faint)]" />
          <input className="input !w-56 !pl-8" placeholder="Filter projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "favorites", label: "★ Favorites" },
          ]}
        />
        <button className="btn" onClick={() => setAdd(true)}>
          <FolderPlus size={15} /> Add project
        </button>
        <button className="btn btn-primary" onClick={() => setNew(true)}>
          <Sparkles size={15} /> New project
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {projects.length === 0 ? (
          <div className="glass mx-auto mt-10 max-w-xl">
            <Empty icon={<Logo size={54} />} title="Welcome to BluePhoenix">
              Add your first project to see its git branch, time tracked, to-dos and one-click actions in one place.
              <div className="mt-4 flex justify-center gap-2">
                <button className="btn btn-primary" onClick={() => setAdd(true)}>
                  <FolderPlus size={15} /> Add your first project
                </button>
                <button className="btn" onClick={() => setNew(true)}>
                  <Sparkles size={15} /> Start a new one
                </button>
              </div>
            </Empty>
          </div>
        ) : shown.length === 0 ? (
          <Empty icon={filter === "favorites" ? <Star size={32} /> : <Search size={32} />} title="No matching projects">
            {filter === "favorites" ? "Star a project to pin it here." : "Try a different search."}
          </Empty>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(350px, 1fr))" }}>
            {shown.map((p) => (
              <ProjectCard key={p.id} project={p} onRemove={() => void askRemove(p)} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
      </div>

      <NewProjectDialog open={newOpen} onClose={() => setNew(false)} />
      <ProjectDialog open={addOpen} onClose={() => setAdd(false)} editing={null} />
      <ProjectDialog open={!!editing} onClose={() => setEditing(null)} editing={editing} />
      {node}
    </div>
  );
}
