import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppWindow,
  Atom,
  Bird,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  Cog,
  FileCode2,
  Flame,
  FolderOpen,
  Hexagon,
  Image as ImageIcon,
  Layers,
  Rocket,
  Smartphone,
  TriangleAlert,
  Zap,
  Circle,
  Triangle,
  Laptop,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, uid } from "../lib/api";
import {
  GROUPS,
  TEMPLATES,
  buildPlan,
  defaultConfig,
  extraCommands,
  parseDeps,
  requiredTools,
  resolved,
  slugify,
  validate,
  type InitConfig,
  type Pm,
  type Step,
  type Template,
} from "../lib/initializer";
import { useStore } from "../lib/store";
import type { IconInfo, InitProgress, InitResult, Preflight, Project } from "../lib/types";
import { goToProject } from "./projectMenu";
import { Field, Modal, Segmented, Spinner, Toggle } from "./ui";

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

const ICON_TARGET_NAMES: Record<string, string> = {
  tauri: "Windows, macOS and Linux",
  web: "favicons, Apple touch icon and web manifest sizes",
  apple: "iOS and macOS",
  android: "Android",
  expo: "Expo (iOS, Android, web)",
  windows: "Windows",
  "flutter-web": "web",
};

type Phase = "type" | "configure" | "run";
type StepState = { status: "pending" | "running" | "ok" | "warn" | "error"; note?: string };

const PM_ORDER: Pm[] = ["pnpm", "npm", "bun", "yarn"];

function stepSummary(s: Step): string {
  if (s.kind === "run") return [s.program, ...s.args].join(" ");
  if (s.kind === "write") return `write ${s.path}`;
  if (s.kind === "jsonSet") return `edit ${s.file}`;
  if (s.kind === "replace") return `edit ${s.file}`;
  if (s.kind === "icons") return `icons → ${s.targets.join(", ")}`;
  return s.commit ? "git init + commit" : "git init";
}

export function NewProjectDialog({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const { projects, loadProjects, refreshStatus, toast, system, settings, setSetting } = useStore();
  const [phase, setPhase] = useState<Phase>("type");
  const [tpl, setTpl] = useState<Template | null>(null);
  const [cfg, setCfg] = useState<InitConfig | null>(null);
  const [tools, setTools] = useState<Record<string, boolean>>({});
  const [pre, setPre] = useState<Preflight | null>(null);
  const [iconInfo, setIconInfo] = useState<IconInfo | null>(null);
  const [iconError, setIconError] = useState<string | null>(null);

  // run state
  const [plan, setPlan] = useState<Step[]>([]);
  const [states, setStates] = useState<StepState[]>([]);
  const [log, setLog] = useState<{ step: number; line: string }[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [result, setResult] = useState<InitResult | null>(null);
  const [registering, setRegistering] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const running = runId !== null && result === null;

  useEffect(() => {
    if (!isOpen) return;
    setPhase("type");
    setTpl(null);
    setCfg(null);
    setIconInfo(null);
    setIconError(null);
    setResult(null);
    setRunId(null);
    setLog([]);
    void api.initTools(["pnpm", "npm", "yarn", "bun", "git", "gh"]).then(setTools);
  }, [isOpen]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const defaultPm = useMemo<Pm>(() => PM_ORDER.find((p) => tools[p]) ?? "npm", [tools]);

  function pick(t: Template) {
    const home = system?.home ?? "";
    const parent = settings.newProjectParent || (home ? `${home}/Developer` : "");
    setTpl(t);
    setCfg(defaultConfig(t, parent, defaultPm));
    setIconInfo(null);
    setIconError(null);
    setPhase("configure");
  }

  const patch = (p: Partial<InitConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));

  const r = tpl && cfg ? resolved(tpl, cfg) : null;
  const needed = useMemo(() => (tpl && cfg ? requiredTools(tpl, cfg) : []), [tpl, cfg]);
  const neededKey = needed.map((n) => n.program).join(",");

  // Which of the tools this setup needs are installed.
  useEffect(() => {
    if (!neededKey) return;
    void api.initTools(neededKey.split(",")).then((t) => setTools((old) => ({ ...old, ...t })));
  }, [neededKey]);

  const folderKey = r ? `${r.parent}\u0000${r.folder}` : "";
  useEffect(() => {
    if (!r || phase !== "configure" || !r.folder) {
      setPre(null);
      return;
    }
    const t = setTimeout(() => void api.initPreflight(r.parent, r.folder).then(setPre).catch(() => setPre(null)), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderKey, phase]);

  const missing = needed.filter((n) => n.required && tools[n.program] === false);
  const problem = tpl && cfg ? validate(tpl, cfg) : null;
  const blocked = pre?.exists && !pre.empty ? "That folder already exists and is not empty." : null;
  const projectExists = r && pre && projects.some((p) => p.path === pre.path);
  const canCreate = !!tpl && !!cfg && !problem && !blocked && missing.length === 0 && !projectExists;

  async function chooseParent() {
    const dir = await open({ directory: true, multiple: false, title: "Where should the project be created?" });
    if (typeof dir === "string") patch({ parent: dir });
  }

  async function chooseIcon() {
    const file = await open({
      multiple: false,
      title: "Choose an app icon",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico"] }],
    });
    if (typeof file !== "string") return;
    try {
      const info = await api.iconInfo(file);
      setIconInfo(info);
      setIconError(null);
      patch({ icon: file });
    } catch (e) {
      setIconError(errMsg(e));
    }
  }

  async function execute(steps: Step[], startAt: number, id: string) {
    if (!r) return;
    setRunId(id);
    setResult(null);
    const un = await listen<InitProgress>("init-progress", (e) => {
      const p = e.payload;
      if (p.runId !== id) return;
      if (p.status === "log") {
        setLog((l) => [...l.slice(-1500), { step: p.step, line: p.line ?? "" }]);
        return;
      }
      setStates((s) => {
        const n = [...s];
        n[p.step] = {
          status: p.status === "start" ? "running" : (p.status as StepState["status"]),
          note: p.line ?? undefined,
        };
        return n;
      });
      if (p.status === "warn" || p.status === "error") {
        if (p.line) setLog((l) => [...l, { step: p.step, line: `${p.status === "error" ? "ERROR" : "Note"}: ${p.line}` }]);
      }
    });
    try {
      const res = await api.initRun({ runId: id, parent: r.parent, folder: r.folder, steps, startAt });
      setResult(res);
      if (res.ok) await register(res.path);
    } catch (e) {
      setResult({ ok: false, cancelled: false, path: "", failedStep: null, error: errMsg(e) });
    } finally {
      un();
    }
  }

  async function create() {
    if (!tpl || !cfg || !r) return;
    const steps = buildPlan(tpl, cfg);
    setPlan(steps);
    setStates(steps.map(() => ({ status: "pending" })));
    setLog([]);
    setPhase("run");
    void setSetting("newProjectParent", r.parent);
    await execute(steps, 0, uid());
  }

  async function retry() {
    if (!result) return;
    const from = result.failedStep ?? 0;
    setStates((s) => s.map((x, i) => (i >= from ? { status: "pending" } : x)));
    await execute(plan, from, uid());
  }

  /** Adds the finished project to BluePhoenix with the commands the new folder offers. */
  async function register(path: string) {
    if (!tpl || !cfg || !r) return;
    setRegistering(true);
    try {
      const d = await api.detect(path).catch(() => null);
      const now = Date.now();
      const project: Project = await api.saveProject({
        id: uid(),
        name: r.name.trim(),
        description: r.description.trim() || d?.description || null,
        path,
        kind: tpl.kind,
        favorite: false,
        githubUrl: d?.githubUrl ?? null,
        websiteUrl: null,
        defaultEditor: null,
        defaultTerminal: null,
        defaultCommandId: null,
        lastOpened: null,
        createdAt: now,
        updatedAt: now,
      });
      const found = d?.commands ?? [];
      const extra = extraCommands(tpl, cfg).filter((c) => !found.some((f) => f.command === c.command));
      const chosen = [...extra.map((c) => ({ ...c, source: "auto" })), ...found.slice(0, 12)];
      let i = 0;
      for (const c of chosen) {
        await api.saveCommand({ id: uid(), projectId: project.id, label: c.label, command: c.command, cwd: null, source: "auto", sort: i++ });
      }
      void api.indexFiles(project.id, path).catch(() => undefined);
      void api
        .projectFileWrite(path, {
          name: project.name,
          description: project.description,
          kind: project.kind,
          githubUrl: project.githubUrl,
          websiteUrl: null,
          defaultEditor: null,
          defaultTerminal: null,
          commands: chosen.map((c) => ({ label: c.label, command: c.command, cwd: null, source: "auto" })),
        })
        .catch(() => undefined);
      await loadProjects();
      void useStore.getState().loadCommands(project.id);
      void refreshStatus(project.id);
      toast({ kind: "success", title: `Created ${project.name}` });
      onClose();
      goToProject(project.id);
    } catch (e) {
      toast({ kind: "error", title: "The project was created but could not be added", detail: errMsg(e) });
    } finally {
      setRegistering(false);
    }
  }

  function close() {
    if (running) {
      void api.initCancel(runId!);
      return;
    }
    onClose();
  }

  // ---------- views ----------

  const typeView = (
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
                onClick={() => pick(t)}
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

  const configureView =
    tpl && cfg && r ? (
      <div className="flex flex-col gap-3.5">
        <button className="btn btn-ghost btn-sm -ml-2 w-fit" onClick={() => setPhase("type")}>
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
                <button className="btn btn-icon shrink-0" aria-label="Choose folder" onClick={chooseParent}>
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
              <button className="btn btn-sm" onClick={chooseIcon}>
                {iconInfo ? "Change…" : "Choose image…"}
              </button>
              {iconInfo && (
                <button
                  className="btn btn-sm btn-ghost btn-icon"
                  aria-label="Remove icon"
                  onClick={() => {
                    setIconInfo(null);
                    patch({ icon: null });
                  }}
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
    ) : null;

  const runView = (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1">
        {plan.map((s, i) => {
          const st = states[i]?.status ?? "pending";
          return (
            <li key={i} className="flex items-start gap-2.5 text-[13px]">
              <span className="mt-0.5 w-4 shrink-0">
                {st === "running" ? (
                  <Spinner size={14} />
                ) : st === "ok" ? (
                  <CircleCheck size={15} className="text-[var(--ok,#16a34a)]" />
                ) : st === "warn" ? (
                  <TriangleAlert size={15} className="text-[var(--warn,#d97706)]" />
                ) : st === "error" ? (
                  <CircleAlert size={15} className="text-[var(--danger,#dc2626)]" />
                ) : (
                  <Circle size={14} className="text-[var(--fg-faint)]" />
                )}
              </span>
              <span className="min-w-0">
                <span className={st === "pending" ? "text-[var(--fg-faint)]" : ""}>{s.label}</span>
                {(st === "warn" || st === "error") && states[i]?.note && (
                  <span className={`block text-xs ${st === "error" ? "text-[var(--danger,#dc2626)]" : "text-[var(--fg-muted)]"}`}>{states[i].note}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <div ref={logRef} className="max-h-52 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--hover)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--fg-muted)]">
        {log.length === 0 ? "Waiting for output…" : log.map((l, i) => <div key={i}>{l.line}</div>)}
      </div>
      {result && !result.ok && (
        <p className="text-[13px] text-[var(--danger,#dc2626)]">
          {result.cancelled ? "Cancelled. Files created so far were left in the folder." : (result.error ?? "Something went wrong.")}
        </p>
      )}
      {registering && (
        <p className="flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
          <Spinner size={14} /> Adding the project to BluePhoenix…
        </p>
      )}
    </div>
  );

  const footer =
    phase === "configure" ? (
      <>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!canCreate} onClick={create}>
          Create project
        </button>
      </>
    ) : phase === "run" ? (
      running ? (
        <button className="btn" onClick={() => api.initCancel(runId!)}>
          Cancel
        </button>
      ) : result && !result.ok ? (
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn" onClick={() => setPhase("configure")}>
            Back to settings
          </button>
          {!result.cancelled && result.failedStep !== null && (
            <button className="btn btn-primary" onClick={retry}>
              Retry from this step
            </button>
          )}
          {result.path && (
            <button className="btn" onClick={() => void register(result.path)} disabled={registering}>
              Add folder as a project
            </button>
          )}
        </>
      ) : undefined
    ) : undefined;

  return (
    <Modal open={isOpen} onClose={close} title={phase === "run" ? `Creating ${r?.name.trim() ?? "project"}` : "New project"} width={720} footer={footer}>
      {phase === "type" ? typeView : phase === "configure" ? configureView : runView}
    </Modal>
  );
}
