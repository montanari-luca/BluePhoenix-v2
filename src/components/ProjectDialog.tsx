import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errMsg, uid } from "../lib/api";
import { scanCommands } from "../lib/ai";
import { goToProject } from "./projectMenu";
import { useStore } from "../lib/store";
import type { Detected, DetectedCommand, Project } from "../lib/types";
import { Field, Modal, Spinner } from "./ui";

const KINDS = ["Course", "Research", "Design", "Writing", "Personal", "Other"];

interface FormState {
  name: string;
  description: string;
  path: string;
  kind: string;
  githubUrl: string;
  websiteUrl: string;
}

const EMPTY: FormState = { name: "", description: "", path: "", kind: "Other", githubUrl: "", websiteUrl: "" };

/** Adds a new project (editing === null) or edits an existing one. */
export function ProjectDialog({ open: isOpen, onClose, editing }: { open: boolean; onClose: () => void; editing: Project | null }) {
  const { projects, loadProjects, refreshStatus, toast, editors, terminals } = useStore();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editor, setEditor] = useState("");
  const [terminal, setTerminal] = useState("");
  const [detected, setDetected] = useState<DetectedCommand[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [detecting, setDetecting] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<"choose" | "details">("choose");

  useEffect(() => {
    if (!isOpen) return;
    if (editing) {
      setForm({
        name: editing.name,
        description: editing.description ?? "",
        path: editing.path,
        kind: editing.kind,
        githubUrl: editing.githubUrl ?? "",
        websiteUrl: editing.websiteUrl ?? "",
      });
      setEditor(editing.defaultEditor ?? "");
      setTerminal(editing.defaultTerminal ?? "");
      setStep("details");
    } else {
      setForm(EMPTY);
      setEditor("");
      setTerminal("");
      setStep("choose");
    }
    setDetected([]);
    setPicked(new Set());
  }, [isOpen, editing]);

  const allPicked = detected.length > 0 && detected.every((c) => picked.has(c.command));

  const set = (k: keyof FormState) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function chooseFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Choose the project folder" });
    if (typeof dir !== "string") return;
    if (projects.some((p) => p.path === dir)) {
      toast({ kind: "info", title: "That folder is already a project" });
      return;
    }
    setDetecting(true);
    try {
      const d: Detected = await api.detect(dir);
      setForm({
        name: d.name,
        description: d.description ?? "",
        path: dir,
        kind: d.kind,
        githubUrl: d.githubUrl ?? "",
        websiteUrl: "",
      });
      setDetected(d.commands);
      // Pre-select the most useful commands.
      setPicked(new Set(d.commands.slice(0, 12).map((c) => c.command)));
      setStep("details");
    } catch (e) {
      toast({ kind: "error", title: "Could not read that folder", detail: errMsg(e) });
    } finally {
      setDetecting(false);
    }
  }

  async function scanWithAi() {
    setAiBusy(true);
    try {
      const found = await scanCommands(form.path);
      const known = new Set(detected.map((c) => c.command));
      const fresh = found.filter((c) => !known.has(c.command));
      setDetected((d) => [...d, ...fresh]);
      setPicked((s) => new Set([...s, ...fresh.map((c) => c.command)]));
      toast({ kind: "success", title: `AI found ${fresh.length} more command${fresh.length === 1 ? "" : "s"}` });
    } catch (e) {
      toast({ kind: "error", title: "AI scan failed", detail: errMsg(e) });
    } finally {
      setAiBusy(false);
    }
  }

  async function save() {
    if (!form.name.trim()) return toast({ kind: "error", title: "Give the project a name" });
    setSaving(true);
    try {
      const now = Date.now();
      const base: Project = editing ?? {
        id: uid(),
        name: "",
        description: null,
        path: "",
        kind: "Other",
        favorite: false,
        githubUrl: null,
        websiteUrl: null,
        defaultEditor: null,
        defaultTerminal: null,
        defaultCommandId: null,
        lastOpened: null,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await api.saveProject({
        ...base,
        name: form.name.trim(),
        description: form.description.trim() || null,
        path: form.path.trim(),
        kind: form.kind.trim() || "Other",
        githubUrl: form.githubUrl.trim() || null,
        websiteUrl: form.websiteUrl.trim() || null,
        defaultEditor: editor || null,
        defaultTerminal: terminal || null,
      });
      if (!editing) {
        let i = 0;
        for (const c of detected.filter((d) => picked.has(d.command))) {
          await api.saveCommand({
            id: uid(),
            projectId: saved.id,
            label: c.label,
            command: c.command,
            cwd: null,
            source: c.source === "ai" ? "ai" : "auto",
            sort: i++,
          });
        }
        if (saved.path) void api.indexFiles(saved.id, saved.path).catch(() => undefined);
      }
      await loadProjects();
      void useStore.getState().loadCommands(saved.id);
      void refreshStatus(saved.id);
      toast({ kind: "success", title: editing ? "Project updated" : `Added ${saved.name}` });
      onClose();
      if (!editing) goToProject(saved.id);
    } catch (e) {
      toast({ kind: "error", title: "Could not save the project", detail: errMsg(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={editing ? "Edit project" : "Add a project"}
      width={620}
      footer={
        step === "details" ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving && <Spinner size={14} />} {editing ? "Save" : "Add project"}
            </button>
          </>
        ) : undefined
      }
    >
      {step === "choose" ? (
        <div className="flex flex-col items-stretch gap-3 py-2">
          <p className="text-[13px] text-[var(--fg-muted)]">
            Pick the folder of a software project and BluePhoenix will detect its type, git remote and commands. You can also
            track something without a folder, like a university course.
          </p>
          <button className="btn btn-primary h-11 text-[14px]" onClick={chooseFolder} disabled={detecting}>
            {detecting ? <Spinner /> : <FolderOpen size={17} />} Choose project folder…
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setForm({ ...EMPTY, kind: "Course" });
              setStep("details");
            }}
          >
            Track something without a folder
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => set("name")(e.target.value)} autoFocus />
          </Field>
          <Field label="Description (optional)">
            <textarea className="input" rows={2} value={form.description} onChange={(e) => set("description")(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <input className="input" list="bp-kinds" value={form.kind} onChange={(e) => set("kind")(e.target.value)} />
              <datalist id="bp-kinds">
                {KINDS.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </Field>
            <Field label="Folder">
              <div className="flex gap-2">
                <input className="input" value={form.path} placeholder="No folder" onChange={(e) => set("path")(e.target.value)} />
                {editing && (
                  <button
                    className="btn btn-icon shrink-0"
                    aria-label="Choose folder"
                    onClick={async () => {
                      const dir = await open({ directory: true, multiple: false });
                      if (typeof dir === "string") set("path")(dir);
                    }}
                  >
                    <FolderOpen size={15} />
                  </button>
                )}
              </div>
            </Field>
            <Field label="GitHub URL">
              <input className="input" value={form.githubUrl} placeholder="https://github.com/…" onChange={(e) => set("githubUrl")(e.target.value)} />
            </Field>
            <Field label="Website">
              <input className="input" value={form.websiteUrl} placeholder="https://…" onChange={(e) => set("websiteUrl")(e.target.value)} />
            </Field>
            <Field label="Default editor">
              <select className="input" value={editor} onChange={(e) => setEditor(e.target.value)}>
                <option value="">Use my global default</option>
                {editors.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
                <option value="system">System default app</option>
              </select>
            </Field>
            <Field label="Default terminal">
              <select className="input" value={terminal} onChange={(e) => setTerminal(e.target.value)}>
                <option value="">Use my global default</option>
                <option value="embedded">Embedded terminal</option>
                <option value="system">System terminal</option>
                {terminals.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {!editing && form.path && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="label !mb-0">Commands found ({detected.length})</span>
                <div className="flex items-center gap-2">
                  {detected.length > 0 && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setPicked(allPicked ? new Set() : new Set(detected.map((c) => c.command)))}
                    >
                      {allPicked ? "Deselect all" : "Select all"}
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={scanWithAi} disabled={aiBusy}>
                    {aiBusy ? <Spinner size={13} /> : <Sparkles size={13} />} Scan with AI
                  </button>
                </div>
              </div>
              {detected.length === 0 ? (
                <p className="text-xs text-[var(--fg-faint)]">
                  Nothing detected automatically. You can add commands later, or let AI scan the repository.
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto rounded-xl border border-[var(--line)] p-1">
                  {detected.map((c) => (
                    <label key={c.command} className="row-hover flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={picked.has(c.command)}
                        onChange={(e) =>
                          setPicked((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(c.command);
                            else n.delete(c.command);
                            return n;
                          })
                        }
                      />
                      <span className="w-40 shrink-0 truncate text-[13px]">{c.label}</span>
                      <code className="truncate font-mono text-xs text-[var(--fg-muted)]">{c.command}</code>
                      {c.source === "ai" && <Sparkles size={12} className="shrink-0 text-[var(--accent)]" />}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
