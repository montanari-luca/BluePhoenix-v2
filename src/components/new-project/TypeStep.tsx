import { AppWindow, Atom, Bird, Bookmark, Circle, Cog, Download, EllipsisVertical, FileCode2, Flame, Hexagon, Laptop, Layers, Rocket, Smartphone, Trash2, Triangle, Upload, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { GROUPS, type Template } from "../../lib/initializer";
import { Dropdown } from "../ui";

const ICONS: Record<string, ReactNode> = {
  AppWindow: <AppWindow size={20} />,
  Atom: <Atom size={20} />,
  Layers: <Layers size={20} />,
  Triangle: <Triangle size={20} />,
  Rocket: <Rocket size={20} />,
  Flame: <Flame size={20} />,
  Smartphone: <Smartphone size={20} />,
  Apple: <Laptop size={20} />,
  Cog: <Cog size={20} />,
  FileCode2: <FileCode2 size={20} />,
  Zap: <Zap size={20} />,
  Hexagon: <Hexagon size={20} />,
  Bird: <Bird size={20} />,
  Bookmark: <Bookmark size={20} />,
};

export interface TypeStepProps {
  templates: Template[];
  onPick: (t: Template) => void;
  onImport: () => void;
  onExport: (t: Template) => void;
  onDelete: (t: Template) => void;
}

/** Step 1: pick what to build (built-in templates and your own). */
export function TypeStep({ templates, onPick, onImport, onExport, onDelete }: TypeStepProps) {
  const mine = templates.some((t) => t.group === "My templates");
  return (
    <div className="flex flex-col gap-5 pb-1">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-[13px] text-[var(--fg-muted)]">
          Pick what you want to build. BluePhoenix runs the setup commands, installs dependencies, creates the icons and the git repository, then adds the project.
        </p>
        <button className="btn btn-sm btn-ghost shrink-0" onClick={onImport}>
          <Upload size={13} /> Import template…
        </button>
      </div>
      {GROUPS.filter((g) => g !== "My templates" || mine).map((g) => (
        <div key={g}>
          <div className="label">{g}</div>
          <div className="grid grid-cols-2 gap-2.5">
            {templates
              .filter((t) => t.group === g)
              .map((t) => (
                <div key={t.id} className="relative">
                  <button className="row-hover flex w-full items-start gap-3 rounded-xl border border-[var(--line)] p-3 text-left" onClick={() => onPick(t)}>
                    <span className="mt-0.5 text-[var(--accent)]">{ICONS[t.icon] ?? <Circle size={20} />}</span>
                    <span className="min-w-0 pr-6">
                      <span className="block text-[14px] font-semibold">{t.name}</span>
                      <span className="block text-xs text-[var(--fg-muted)]">{t.blurb}</span>
                    </span>
                  </button>
                  {g === "My templates" && (
                    <div className="absolute top-2 right-2">
                      <Dropdown
                        items={[
                          { label: "Export…", icon: <Download size={14} />, onClick: () => onExport(t) },
                          { label: "Delete", icon: <Trash2 size={14} />, danger: true, onClick: () => onDelete(t) },
                        ]}
                      >
                        <button className="btn btn-ghost btn-icon btn-sm" aria-label={`${t.name} options`}>
                          <EllipsisVertical size={14} />
                        </button>
                      </Dropdown>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
