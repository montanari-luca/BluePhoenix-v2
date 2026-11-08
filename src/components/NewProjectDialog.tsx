import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg, uid } from "../lib/api";
import {
  TEMPLATES,
  buildPlan,
  customTemplate,
  defaultConfig,
  extraCommands,
  requiredTools,
  resolved,
  slugify,
  templateBody,
  validate,
  type InitConfig,
  type Pm,
  type Step,
  type Template,
} from "../lib/initializer";
import { useStore, logError, reportError } from "../lib/store";
import type { CustomTemplate, IconInfo, InitProgress, InitResult, Preflight, Project } from "../lib/types";
import { ConfigureStep } from "./new-project/ConfigureStep";
import { RunStep } from "./new-project/RunStep";
import { PM_ORDER, type Phase, type StepState } from "./new-project/shared";
import { TypeStep } from "./new-project/TypeStep";
import { goToProject } from "./projectMenu";
import { Field, Modal, useConfirm } from "./ui";

// The New project wizard: pick a template (TypeStep), answer its questions (ConfigureStep), then
// watch the backend run the plan (RunStep). This file holds the state and the actions.

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

  // the user's own templates
  const [custom, setCustom] = useState<CustomTemplate[]>([]);
  const [saving, setSaving] = useState<{ name: string; blurb: string } | null>(null);
  const { confirm, node: confirmNode } = useConfirm();
  const loadCustom = () => api.templates().then(setCustom).catch(logError("load templates"));
  const allTemplates = useMemo(() => [...custom.map(customTemplate), ...TEMPLATES], [custom]);
  const customOf = (t: Template) => custom.find((c) => `custom:${c.id}` === t.id);

  async function importTemplate() {
    const file = await open({ title: "Import a template", multiple: false, filters: [{ name: "BluePhoenix template", extensions: ["json"] }] });
    if (typeof file !== "string") return;
    try {
      const t = await api.importTemplate(file);
      await loadCustom();
      toast({ kind: "success", title: `Imported “${t.name}”`, detail: "It is under My templates." });
    } catch (e) {
      toast({ kind: "error", title: "Could not import the template", detail: errMsg(e) });
    }
  }

  async function exportTemplate(t: Template) {
    const c = customOf(t);
    if (!c) return;
    const path = await save({ title: "Export template", defaultPath: `${slugify(c.name) || "template"}.bluephoenix-template.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    await api.exportTemplate(c.id, path).then(
      () => toast({ kind: "success", title: "Template exported", detail: path }),
      (e) => toast({ kind: "error", title: "Could not export", detail: errMsg(e) }),
    );
  }

  async function deleteTemplate(t: Template) {
    const c = customOf(t);
    if (!c || !(await confirm(`Delete the template “${c.name}”? Projects made from it are not affected.`))) return;
    await api.deleteTemplate(c.id).catch(reportError("Could not delete the template"));
    await loadCustom();
  }

  async function saveTemplate() {
    if (!tpl || !cfg || !saving) return;
    const base = customOf(tpl);
    try {
      await api.saveTemplate({
        id: uid(),
        name: saving.name.trim(),
        blurb: saving.blurb.trim(),
        kind: tpl.kind,
        icon: tpl.icon,
        baseId: base?.baseId ?? tpl.id,
        body: templateBody(tpl, cfg),
        createdAt: 0,
        updatedAt: 0,
      });
      setSaving(null);
      await loadCustom();
      toast({ kind: "success", title: `Saved “${saving.name.trim()}”`, detail: "Find it under My templates next time." });
    } catch (e) {
      toast({ kind: "error", title: "Could not save the template", detail: errMsg(e) });
    }
  }

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
    void loadCustom();
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
    const t = setTimeout(() => void api.initPreflight(r.parent, r.folder).then(setPre).catch((e) => setPre(logError("preflight", null)(e))), 250);
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
      const d = await api.detect(path).catch(logError("detect project type", null));
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
      void api.indexFiles(project.id, path).catch(reportError("Could not index the project files"));
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
        .catch(reportError("Could not write the .bluephoenix file"));
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

  const configureView =
    tpl && cfg && r ? (
      <ConfigureStep
        tpl={tpl}
        cfg={cfg}
        r={r}
        patch={patch}
        tools={tools}
        pre={pre}
        iconInfo={iconInfo}
        iconError={iconError}
        missing={missing}
        blocked={blocked}
        projectExists={!!projectExists}
        problem={problem}
        onBack={() => setPhase("type")}
        onChooseParent={chooseParent}
        onChooseIcon={chooseIcon}
        onClearIcon={() => {
          setIconInfo(null);
          patch({ icon: null });
        }}
      />
    ) : null;

  const runView = <RunStep plan={plan} states={states} log={log} logRef={logRef} result={result} registering={registering} />;

  const footer =
    phase === "configure" ? (
      <>
        <button
          className="btn btn-ghost mr-auto"
          disabled={!tpl || !cfg?.name.trim()}
          title="Keep these choices (steps, dependencies, files) as a template for next time"
          onClick={() => setSaving({ name: `My ${tpl?.name ?? "template"}`, blurb: "" })}
        >
          Save as template…
        </button>
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
      {phase === "type" ? (
        <TypeStep templates={allTemplates} onPick={pick} onImport={() => void importTemplate()} onExport={(t) => void exportTemplate(t)} onDelete={(t) => void deleteTemplate(t)} />
      ) : phase === "configure" ? (
        configureView
      ) : (
        runView
      )}
      <Modal
        open={!!saving}
        onClose={() => setSaving(null)}
        title="Save as template"
        width={460}
        footer={
          <>
            <button className="btn" onClick={() => setSaving(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!saving?.name.trim()} onClick={() => void saveTemplate()}>
              Save template
            </button>
          </>
        }
      >
        {saving && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-[var(--fg-muted)]">
              Saves the steps, dependencies and files of this setup. Next time you only enter a name; the project name, folder and identifier are filled in for you. Git and icons are chosen each time.
            </p>
            <Field label="Template name">
              <input className="input" autoFocus value={saving.name} onChange={(e) => setSaving({ ...saving, name: e.target.value })} />
            </Field>
            <Field label="Short description (optional)">
              <input className="input" value={saving.blurb} placeholder="React + Tailwind + our lint setup" onChange={(e) => setSaving({ ...saving, blurb: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
      {confirmNode}
    </Modal>
  );
}
