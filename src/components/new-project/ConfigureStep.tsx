import { ChevronLeft, FolderOpen, Image as ImageIcon, TriangleAlert, X } from "lucide-react";
import { buildPlan, parseDeps, slugify, type InitConfig, type Pm, type Template, type Tool } from "../../lib/initializer";
import type { IconInfo, Preflight } from "../../lib/types";
import { Field, Segmented, Toggle } from "../ui";
import { ICON_TARGET_NAMES, PM_ORDER, stepSummary } from "./shared";

export interface ConfigureStepProps {
  tpl: Template;
  cfg: InitConfig;
  /** `cfg` with derived values (folder, identifier) filled in. */
  r: InitConfig;
  patch: (p: Partial<InitConfig>) => void;
  tools: Record<string, boolean>;
  pre: Preflight | null;
  iconInfo: IconInfo | null;
  iconError: string | null;
  missing: Tool[];
  blocked: string | null;
  projectExists: boolean;
  problem: string | null;
  onBack: () => void;
  onChooseParent: () => void;
  onChooseIcon: () => void;
  onClearIcon: () => void;
}

/** Step 2: name, folder, options, dependencies, icon and git. */
export function ConfigureStep({
  tpl,
  cfg,
  r,
  patch,
  tools,
  pre,
  iconInfo,
  iconError,
  missing,
  blocked,
  projectExists,
  problem,
  onBack,
  onChooseParent,
  onChooseIcon,
  onClearIcon,
}: ConfigureStepProps) {
  return (
    <div className="flex flex-col gap-3.5">
      <button className="btn btn-ghost btn-sm -ml-2 w-fit" onClick={onBack}>
        <ChevronLeft size={14} /> {tpl.name}
      </button>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input className="input" autoFocus value={cfg.name} placeholder="My app" onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label="Folder name">
          <input
            className="input"
            value={cfg.folder}
            placeholder={slugify(cfg.name) || "my-app"}
            onChange={(e) => patch({ folder: e.target.value.toLowerCase() })}
          />
        </Field>
        <div className="col-span-2">
          <Field label="Create in">
            <div className="flex gap-2">
              <input className="input" value={cfg.parent} onChange={(e) => patch({ parent: e.target.value })} />
              <button className="btn btn-icon shrink-0" aria-label="Choose folder" onClick={onChooseParent}>
                <FolderOpen size={15} />
              </button>
            </div>
            {r.folder && <p className="mt-1 truncate text-xs text-[var(--fg-faint)]">{pre?.path ?? `${r.parent}/${r.folder}`}</p>}
          </Field>
        </div>
        {!tpl.noVersion && (
          <Field label="Version">
            <input className="input" value={cfg.version} placeholder="0.1.0" onChange={(e) => patch({ version: e.target.value })} />
          </Field>
        )}
        {tpl.identifier && (
          <Field label={tpl.identifier.label}>
            <input className="input" value={cfg.identifier} placeholder={tpl.identifier.placeholder(r)} onChange={(e) => patch({ identifier: e.target.value })} />
          </Field>
        )}
        {tpl.frameworks && (
          <Field label={tpl.frameworkLabel ?? "Framework"}>
            <select className="input" value={cfg.framework} onChange={(e) => patch({ framework: e.target.value })}>
              {tpl.frameworks.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {tpl.languages && (tpl.languageApplies?.(r) ?? true) && (
          <Field label="Language">
            <Segmented value={cfg.language} onChange={(language) => patch({ language })} options={tpl.languages} />
          </Field>
        )}
        {tpl.options
          .filter((o) => o.type === "select")
          .map((o) => (
            <Field key={o.id} label={o.label}>
              <select className="input" value={String(cfg.options[o.id])} onChange={(e) => patch({ options: { ...cfg.options, [o.id]: e.target.value } })}>
                {o.choices?.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        {tpl.usesPm && (
          <Field label="Package manager">
            <select className="input" value={cfg.pm} onChange={(e) => patch({ pm: e.target.value as Pm })}>
              {PM_ORDER.map((p) => (
                <option key={p} value={p}>
                  {p}
                  {tools[p] === false ? " (not installed)" : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="col-span-2">
          <Field label="Description (optional)">
            <input className="input" value={cfg.description} onChange={(e) => patch({ description: e.target.value })} />
          </Field>
        </div>
      </div>

      {tpl.options.some((o) => o.type === "toggle") && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-[var(--line)] p-3">
          {tpl.options
            .filter((o) => o.type === "toggle")
            .map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3 text-[13px]">
                {o.label}
                <Toggle label={o.label} checked={cfg.options[o.id] === true} onChange={(v) => patch({ options: { ...cfg.options, [o.id]: v } })} />
              </div>
            ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {tpl.depGroups.map((g) => (
          <Field key={g.id} label={g.label} hint={parseDeps(cfg.deps[g.id]).length ? `${parseDeps(cfg.deps[g.id]).length} to add` : "Separate with spaces or commas"}>
            <textarea
              className="input font-mono text-xs"
              rows={2}
              value={cfg.deps[g.id] ?? ""}
              placeholder={g.placeholder}
              onChange={(e) => patch({ deps: { ...cfg.deps, [g.id]: e.target.value } })}
            />
          </Field>
        ))}
      </div>

      {tpl.icons.length > 0 && (
        <Field
          label="App icon (optional)"
          hint={`Generates ${tpl.icons.map((t) => ICON_TARGET_NAMES[t] ?? t).join(", ")} icons from one image. A square PNG of at least 1024×1024 works best.`}
        >
          <div className="flex items-center gap-3">
            {iconInfo ? (
              <img src={iconInfo.dataUrl} alt="" className="h-12 w-12 rounded-xl border border-[var(--line)] object-cover" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-[var(--line)] text-[var(--fg-faint)]">
                <ImageIcon size={18} />
              </div>
            )}
            <div className="min-w-0 flex-1 text-xs text-[var(--fg-muted)]">
              {iconInfo ? (
                <>
                  <div className="truncate">{cfg.icon}</div>
                  <div className={iconInfo.width < 1024 || iconInfo.height < 1024 ? "text-[var(--warn,#d97706)]" : ""}>
                    {iconInfo.width}×{iconInfo.height}
                    {(iconInfo.width < 1024 || iconInfo.height < 1024) && " — smaller than 1024px, large icons will look soft"}
                    {iconInfo.width !== iconInfo.height && " — will be padded to a square"}
                  </div>
                </>
              ) : (
                "No icon chosen: the starter's default icon is kept."
              )}
              {iconError && <div className="text-[var(--danger,#dc2626)]">{iconError}</div>}
            </div>
            <button className="btn btn-sm" onClick={onChooseIcon}>
              {iconInfo ? "Change…" : "Choose image…"}
            </button>
            {iconInfo && (
              <button
                className="btn btn-sm btn-ghost btn-icon"
                aria-label="Remove icon"
                onClick={onClearIcon}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </Field>
      )}

      <div className="flex flex-col gap-2.5 rounded-xl border border-[var(--line)] p-3">
        <div className="flex items-center justify-between text-[13px]">
          <span>
            Initialize a git repository with a first commit
            <span className="block text-xs text-[var(--fg-faint)]">Runs git init and commits the generated files.</span>
          </span>
          <Toggle label="Initialize git" checked={cfg.git} onChange={(git) => patch({ git, github: git ? cfg.github : "" })} />
        </div>
        {cfg.git && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch">
              <input className="input" value={cfg.branch} onChange={(e) => patch({ branch: e.target.value })} />
            </Field>
            <Field label="GitHub repository" hint={tools.gh === false ? "Install the GitHub CLI (gh) to enable this." : "Creates it with gh and pushes."}>
              <select className="input" value={cfg.github} disabled={tools.gh === false} onChange={(e) => patch({ github: e.target.value as InitConfig["github"] })}>
                <option value="">Don’t create one</option>
                <option value="private">Private repository</option>
                <option value="public">Public repository</option>
              </select>
            </Field>
          </div>
        )}
      </div>

      <details className="text-xs text-[var(--fg-muted)]">
        <summary className="cursor-pointer select-none">Steps that will run</summary>
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
          {buildPlan(tpl, cfg).map((s, i) => (
            <li key={i}>
              <span className="text-[var(--fg)]">{s.label}</span>
              <code className="ml-2 font-mono text-[11px] text-[var(--fg-faint)]">{stepSummary(s)}</code>
            </li>
          ))}
        </ol>
      </details>

      {missing.length > 0 && (
        <div className="flex gap-2 rounded-xl border border-[var(--line)] p-3 text-[13px]">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-[var(--danger,#dc2626)]" />
          <div>
            Missing tools:
            {missing.map((m) => (
              <div key={m.program}>
                <code className="font-mono">{m.program}</code> <span className="text-[var(--fg-muted)]">{m.hint}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {(blocked || projectExists) && <p className="text-[13px] text-[var(--danger,#dc2626)]">{blocked ?? "That folder is already a project."}</p>}
      {!blocked && !projectExists && problem && cfg.name.trim() && <p className="text-[13px] text-[var(--danger,#dc2626)]">{problem}</p>}
    </div>
  );
}
