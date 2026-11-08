import { AppWindow, Atom, Bird, Circle, Cog, FileCode2, Flame, Hexagon, Laptop, Layers, Rocket, Smartphone, Triangle, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { GROUPS, TEMPLATES, type Template } from "../../lib/initializer";

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
};

/** Step 1: pick what to build. */
export function TypeStep({ onPick }: { onPick: (t: Template) => void }) {
  return (
    <div className="flex flex-col gap-5 pb-1">
      <p className="text-[13px] text-[var(--fg-muted)]">
        Pick what you want to build. BluePhoenix runs the setup commands, installs dependencies, creates the icons and the git repository, then adds the project.
      </p>
      {GROUPS.map((g) => (
        <div key={g}>
          <div className="label">{g}</div>
          <div className="grid grid-cols-2 gap-2.5">
            {TEMPLATES.filter((t) => t.group === g).map((t) => (
              <button
                key={t.id}
                className="row-hover flex items-start gap-3 rounded-xl border border-[var(--line)] p-3 text-left"
                onClick={() => onPick(t)}
              >
                <span className="mt-0.5 text-[var(--accent)]">{ICONS[t.icon] ?? <Circle size={20} />}</span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold">{t.name}</span>
                  <span className="block text-xs text-[var(--fg-muted)]">{t.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
