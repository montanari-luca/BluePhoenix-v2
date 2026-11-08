import { FileText, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { hasFolder } from "../lib/actions";
import { api, errMsg } from "../lib/api";
import {
  AUTOMATION_TEMPLATES,
  type HourUnit,
  TRIGGER_LABELS,
  formatHours,
  fromLocalInput,
  fromTemplate,
  joinHours,
  newAutomation,
  splitHours,
  toLocalInput,
  validateAutomation,
} from "../lib/automations";
import { formatDateTime } from "../lib/format";
import { useStore, logError } from "../lib/store";
import type { Automation, AutomationRun, AutomationTrigger } from "../lib/types";
import { ProjectMultiSelect } from "./ProjectMultiSelect";
import { Field, Modal, Segmented, Spinner } from "./ui";

const RUN_COLOR: Record<AutomationRun["status"], string> = { ok: "var(--ok)", failed: "var(--bad)", timeout: "var(--warn)" };

export function AutomationDialog({
  open,
  onClose,
  editing,
  startWithTemplates,
}: {
  open: boolean;
  onClose: () => void;
  editing: Automation | null;
  startWithTemplates: boolean;
}) {
  const projects = useStore((s) => s.projects);
  const toast = useStore((s) => s.toast);
  const loadAutomations = useStore((s) => s.loadAutomations);
  const [step, setStep] = useState<"choose" | "details">("details");
  const [form, setForm] = useState<Automation>(newAutomation);
  const [unit, setUnit] = useState<HourUnit>("hours");
  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[]>([]);

  const withFolder = useMemo(() => projects.filter(hasFolder), [projects]);
  const kinds = useMemo(() => [...new Set(projects.map((p) => p.kind))].sort(), [projects]);

  useEffect(() => {
    if (!open) return;
    const start = editing ?? newAutomation();
    setForm(start);
    setUnit(start.repeatHours ? splitHours(start.repeatHours).unit : "hours");
    setStep(!editing && startWithTemplates ? "choose" : "details");
    setSaving(false);
    setRuns([]);
    if (editing) api.automationRuns(editing.id).then(setRuns).catch(logError("load automation runs"));
  }, [open, editing, startWithTemplates]);

  const set = (patch: Partial<Automation>) => setForm((f) => ({ ...f, ...patch }));

  const pickTemplate = (t: (typeof AUTOMATION_TEMPLATES)[number]) => {
    const a = fromTemplate(t);
    setForm(a);
    setUnit(a.repeatHours ? splitHours(a.repeatHours).unit : "hours");
    setStep("details");
  };

  const setTrigger = (trigger: AutomationTrigger) =>
    set({ trigger, notify: trigger !== "schedule" && form.notify === "before" ? "on_run" : form.notify });

  const repeatValue = form.repeatHours == null ? "" : unit === "days" ? form.repeatHours / 24 : form.repeatHours;
  const setRepeat = (n: number | null) => set({ repeatHours: n == null || n < 1 ? null : joinHours(Math.floor(n), unit) });

  const save = async () => {
    const problem = validateAutomation(form);
    if (problem) return toast({ kind: "error", title: problem });
    setSaving(true);
    try {
      await api.saveAutomation(form);
      await loadAutomations();
      toast({ kind: "success", title: editing ? "Automation saved" : "Automation created", detail: form.name });
      onClose();
    } catch (e) {
      toast({ kind: "error", title: "Could not save automation", detail: errMsg(e) });
    } finally {
      setSaving(false);
    }
  };

  const timed = form.trigger !== "manual";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit automation" : step === "choose" ? "Start from a template" : "New automation"}
      width={640}
      footer={
        step === "choose" ? (
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        ) : (
          <>
            {!editing && startWithTemplates && (
              <button className="btn mr-auto" onClick={() => setStep("choose")}>
                Back to templates
              </button>
            )}
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving && <Spinner size={14} />} {editing ? "Save" : "Create automation"}
            </button>
          </>
        )
      }
    >
      {step === "choose" ? (
        <div className="flex flex-col gap-2">
          {AUTOMATION_TEMPLATES.map((t) => (
            <button key={t.id} className="glass row-hover flex items-start gap-3 p-3 text-left" onClick={() => pickTemplate(t)}>
              <FileText size={16} className="mt-0.5 shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold">{t.fields.name}</span>
                <span className="block text-xs text-[var(--fg-muted)]">{t.fields.description}</span>
                <code className="mt-1 block truncate font-mono text-xs text-[var(--fg-faint)]">{t.fields.commands}</code>
              </span>
            </button>
          ))}
          <button
            className="glass row-hover flex items-center gap-3 p-3 text-left"
            onClick={() => {
              setForm(newAutomation());
              setUnit("hours");
              setStep("details");
            }}
          >
            <Zap size={16} className="shrink-0 text-[var(--accent)]" />
            <span className="text-[13px] font-semibold">Empty automation</span>
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <input className="input" autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Clean old builds" />
          </Field>
          <Field label="Description (optional)">
            <input className="input" value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Run">
              <select className="input" value={form.trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
                {(Object.keys(TRIGGER_LABELS) as AutomationTrigger[]).map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            {timed && (
              <Field
                label={form.trigger === "schedule" ? "Date and time" : "Not before (optional)"}
                hint={form.trigger === "schedule" ? "First run. With a repeat, later runs follow the interval." : "It will not run until this moment."}
              >
                <input
                  type="datetime-local"
                  className="input"
                  value={toLocalInput(form.runAt)}
                  onChange={(e) => set({ runAt: fromLocalInput(e.target.value) })}
                />
              </Field>
            )}
          </div>

          {timed && (
            <Field
              label="Repeat"
              hint={
                form.repeatHours
                  ? `Runs again once ${formatHours(form.repeatHours)} have passed since the last run, checked ${
                      form.trigger === "schedule" ? "every minute" : form.trigger === "launch" ? "at launch" : form.trigger === "quit" ? "at quit" : "at each commit"
                    }.`
                  : form.trigger === "schedule"
                    ? "Without a repeat it runs once, at the date above."
                    : form.runAt
                      ? "Without a repeat it runs once after that date."
                      : "Without a repeat it runs every time the trigger fires."
              }
            >
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={form.repeatHours != null}
                    onChange={(e) => set({ repeatHours: e.target.checked ? joinHours(unit === "days" ? 2 : 48, unit) : null })}
                  />
                  Repeat every
                </label>
                <input
                  type="number"
                  min={1}
                  className="input !w-24"
                  disabled={form.repeatHours == null}
                  value={repeatValue}
                  onChange={(e) => setRepeat(e.target.value === "" ? null : Number(e.target.value))}
                />
                <select
                  className="input !w-28"
                  disabled={form.repeatHours == null}
                  value={unit}
                  onChange={(e) => {
                    const u = e.target.value as HourUnit;
                    const n = form.repeatHours == null ? 1 : unit === "days" ? form.repeatHours / 24 : form.repeatHours;
                    setUnit(u);
                    set({ repeatHours: joinHours(n, u) });
                  }}
                >
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
            </Field>
          )}

          <Field label="Alert (system notification)">
            <div className="flex items-center gap-2">
              <select className="input !w-56" value={form.notify} onChange={(e) => set({ notify: e.target.value as Automation["notify"], notifyBeforeMin: e.target.value === "before" ? (form.notifyBeforeMin ?? 10) : null })}>
                <option value="none">No alert</option>
                <option value="on_run">When it runs</option>
                {form.trigger === "schedule" && <option value="before">Before it runs</option>}
              </select>
              {form.notify === "before" && (
                <>
                  <input
                    type="number"
                    min={1}
                    className="input !w-24"
                    value={form.notifyBeforeMin ?? ""}
                    onChange={(e) => set({ notifyBeforeMin: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                  <span className="text-[13px] text-[var(--fg-muted)]">minutes before</span>
                </>
              )}
            </div>
          </Field>

          <Field label="Projects">
            <div className="flex flex-col gap-2">
              <Segmented
                value={form.targetMode}
                onChange={(targetMode) => set({ targetMode })}
                options={[
                  { value: "selected", label: "Selected projects" },
                  { value: "all", label: "All projects" },
                ]}
              />
              {form.targetMode === "selected" ? (
                <ProjectMultiSelect projects={withFolder} value={form.projectIds} onChange={(projectIds) => set({ projectIds })} />
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-[var(--fg-muted)]">Only type</span>
                  <input
                    className="input !w-48"
                    list="automation-kinds"
                    placeholder="Any"
                    value={form.kindFilter ?? ""}
                    onChange={(e) => set({ kindFilter: e.target.value || null })}
                  />
                  <datalist id="automation-kinds">
                    {kinds.map((k) => (
                      <option key={k} value={k} />
                    ))}
                  </datalist>
                </div>
              )}
            </div>
          </Field>

          <Field label="Requisites" hint="Projects that do not meet these are skipped and checked again next time.">
            <div className="flex flex-col gap-2 text-[13px]">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.idleHours != null}
                  onChange={(e) => set({ idleHours: e.target.checked ? 48 : null })}
                />
                Project was not edited in the past
                <input
                  type="number"
                  min={1}
                  className="input !w-20"
                  disabled={form.idleHours == null}
                  value={form.idleHours ?? ""}
                  onChange={(e) => set({ idleHours: e.target.value === "" ? null : Number(e.target.value) })}
                />
                hours
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.requireCleanGit} onChange={(e) => set({ requireCleanGit: e.target.checked })} />
                Git working tree is clean (no uncommitted changes)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.requireGitRepo} onChange={(e) => set({ requireGitRepo: e.target.checked })} />
                Project is a git repository
              </label>
            </div>
          </Field>

          <Field label="Commands" hint="Run in each project's folder, in your shell. Use new lines or && to chain commands.">
            <textarea
              className="input selectable !h-28 resize-y py-2 font-mono text-xs"
              spellCheck={false}
              value={form.commands}
              onChange={(e) => set({ commands: e.target.value })}
              placeholder="cd src-tauri && cargo clean"
            />
          </Field>

          {editing && (
            <details>
              <summary className="label cursor-pointer !mb-0">Recent runs ({runs.length})</summary>
              {runs.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--fg-faint)]">It has not run yet.</p>
              ) : (
                <div className="mt-2 flex max-h-64 flex-col gap-2 overflow-y-auto">
                  {runs.slice(0, 20).map((r) => (
                    <div key={r.id} className="rounded-lg border border-[var(--line)] p-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span style={{ color: RUN_COLOR[r.status] }}>● {r.status}</span>
                        <span className="font-semibold">{r.projectName}</span>
                        <span className="ml-auto text-[var(--fg-faint)]">{formatDateTime(r.startedAt)}</span>
                      </div>
                      {r.output && <pre className="selectable mt-1 max-h-32 overflow-auto font-mono whitespace-pre-wrap text-[var(--fg-muted)]">{r.output}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}
