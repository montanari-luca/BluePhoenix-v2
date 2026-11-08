import { Check, ChevronDown, ChevronRight, Copy, FilePlus2, GripVertical, Inbox, ListChecks, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateTodoPrompt, prioritizeTodos } from "../lib/ai";
import { api, errMsg, uid } from "../lib/api";
import { useStore, logError } from "../lib/store";
import type { Project, Todo, TodoPage, TodoStatus } from "../lib/types";
import { MarkdownEditor } from "../components/Markdown";
import { Dropdown, Empty, Modal, Segmented, Spinner, useConfirm } from "../components/ui";

const PRIORITY = [
  { label: "None", color: "var(--fg-faint)" },
  { label: "Low", color: "var(--info)" },
  { label: "Medium", color: "var(--warn)" },
  { label: "High", color: "var(--bad)" },
];

type Sel = "all" | "inbox" | string;

function useDebounced(fn: () => void, deps: unknown[], ms = 700) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function PageNotes({ page, onSaved }: { page: TodoPage; onSaved: () => void }) {
  const [text, setText] = useState(page.markdown);
  useEffect(() => setText(page.markdown), [page.id, page.markdown]);
  useDebounced(() => {
    if (text !== page.markdown) void api.savePage({ ...page, markdown: text }).then(onSaved);
  }, [text]);
  return <MarkdownEditor value={text} onChange={setText} placeholder="Notes for this page. Markdown is supported: headings, lists, tables, links, code…" minHeight={140} initialMode="split" />;
}

function TodoDetail({ todo, project, onChange, onClose }: { todo: Todo; project: Project; onChange: (t: Todo) => void; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [notes, setNotes] = useState(todo.notes);
  const [prompt, setPrompt] = useState(todo.aiPrompt ?? "");
  const [busy, setBusy] = useState(false);
  useDebounced(() => {
    if (notes !== todo.notes) onChange({ ...todo, notes });
  }, [notes]);

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--line)] px-3 py-3">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Status</label>
          <select className="input" value={todo.status} onChange={(e) => onChange({ ...todo, status: e.target.value as TodoStatus })}>
            <option value="todo">To do</option>
            <option value="doing">In progress</option>
            <option value="done">Done</option>
          </select>
        </div>
        <div>
          <label className="label">Priority</label>
          <select className="input" value={todo.priority} onChange={(e) => onChange({ ...todo, priority: Number(e.target.value) })}>
            {PRIORITY.map((p, i) => (
              <option key={p.label} value={i}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Due date</label>
          <input
            type="date"
            className="input"
            value={todo.due ? new Date(todo.due).toISOString().slice(0, 10) : ""}
            onChange={(e) => onChange({ ...todo, due: e.target.value ? new Date(e.target.value + "T12:00:00").getTime() : null })}
          />
        </div>
      </div>
      <div>
        <label className="label">Notes</label>
        <MarkdownEditor value={notes} onChange={setNotes} placeholder="Details, links, acceptance criteria…" minHeight={90} />
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="label !mb-0">AI prompt</label>
          <div className="flex gap-2">
            {prompt && (
              <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(prompt).then(() => toast({ kind: "success", title: "Prompt copied" }))}>
                <Copy size={13} /> Copy
              </button>
            )}
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const ctx = project.path ? await api.snapshot(project.path).catch(logError("project snapshot", "")) : "";
                  const out = await generateTodoPrompt(project, { ...todo, notes }, ctx);
                  setPrompt(out);
                  onChange({ ...todo, notes, aiPrompt: out });
                } catch (e) {
                  toast({ kind: "error", title: "Could not generate a prompt", detail: errMsg(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner size={13} /> : <Sparkles size={13} />} {prompt ? "Regenerate" : "Generate"}
            </button>
          </div>
        </div>
        {prompt ? (
          <textarea className="input font-mono !text-xs" rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => prompt !== (todo.aiPrompt ?? "") && onChange({ ...todo, aiPrompt: prompt })} />
        ) : (
          <p className="text-xs text-[var(--fg-faint)]">Turn this to-do into a ready-to-paste prompt for your AI coding assistant.</p>
        )}
      </div>
      <div className="flex justify-end">
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export default function TodosTab({ project }: { project: Project }) {
  const toast = useStore((s) => s.toast);
  const loadProjects = useStore((s) => s.loadProjects);
  const [pages, setPages] = useState<TodoPage[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [sel, setSel] = useState<Sel>("all");
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<"manual" | "priority">("manual");
  const [showDone, setShowDone] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [newPage, setNewPage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const dragId = useRef<string | null>(null);
  const { confirm, node } = useConfirm();

  const reload = useCallback(async () => {
    const [pg, td] = await Promise.all([api.pages(project.id), api.todos(project.id)]);
    setPages(pg);
    setTodos(td);
    void loadProjects();
  }, [project.id, loadProjects]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const page = pages.find((p) => p.id === sel);
  const inScope = useMemo(
    () => todos.filter((t) => (sel === "all" ? true : sel === "inbox" ? t.pageId === null : t.pageId === sel)),
    [todos, sel],
  );
  const open_ = useMemo(() => {
    const l = inScope.filter((t) => t.status !== "done");
    return sort === "priority" ? [...l].sort((a, b) => b.priority - a.priority || a.sort - b.sort) : l;
  }, [inScope, sort]);
  const done = inScope.filter((t) => t.status === "done");

  async function save(t: Todo) {
    setTodos((l) => l.map((x) => (x.id === t.id ? t : x)));
    const completedAt = t.status === "done" ? (t.completedAt ?? Date.now()) : null;
    await api.saveTodo({ ...t, completedAt });
    void loadProjects();
    setTodos((l) => l.map((x) => (x.id === t.id ? { ...t, completedAt } : x)));
  }

  async function add() {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    const maxSort = todos.reduce((m, t) => Math.max(m, t.sort), 0);
    await api.saveTodo({
      id: uid(), projectId: project.id, pageId: sel === "all" || sel === "inbox" ? null : sel, title, notes: "", status: "todo",
      priority: 0, due: null, aiPrompt: null, sort: maxSort + 1, createdAt: Date.now(), completedAt: null,
    });
    await reload();
  }

  async function prioritize() {
    setAiBusy(true);
    try {
      const result = await prioritizeTodos(project, inScope);
      const byId = new Map(result.map((r, i) => [r.id, { ...r, rank: i }]));
      const updated = todos.map((t) => {
        const r = byId.get(t.id);
        return r ? { ...t, priority: r.priority, sort: r.rank } : t;
      });
      await api.saveTodos(updated.filter((t) => byId.has(t.id)));
      setReasons(Object.fromEntries(result.map((r) => [r.id, r.reason])));
      setSort("priority");
      await reload();
      toast({ kind: "success", title: "To-dos prioritized", detail: "Hover a to-do to see why." });
    } catch (e) {
      toast({ kind: "error", title: "Could not prioritize", detail: errMsg(e) });
    } finally {
      setAiBusy(false);
    }
  }

  async function drop(targetId: string) {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId || sort !== "manual") return;
    const list = [...open_];
    const fi = list.findIndex((t) => t.id === from);
    const ti = list.findIndex((t) => t.id === targetId);
    if (fi < 0 || ti < 0) return;
    const [moved] = list.splice(fi, 1);
    list.splice(ti, 0, moved);
    await api.saveTodos(list.map((t, i) => ({ ...t, sort: i + 1 })));
    await reload();
  }

  async function createPage() {
    const title = (newPage ?? "").trim();
    setNewPage(null);
    if (!title) return;
    if (renaming && page) {
      setRenaming(false);
      await api.savePage({ ...page, title });
      await reload();
      return;
    }
    const p: TodoPage = { id: uid(), projectId: project.id, title, markdown: "", sort: pages.length };
    await api.savePage(p);
    await reload();
    setSel(p.id);
  }

  const counts = (f: (t: Todo) => boolean) => todos.filter((t) => t.status !== "done" && f(t)).length;

  const row = (t: Todo) => {
    const pr = PRIORITY[t.priority] ?? PRIORITY[0];
    const isOpen = open === t.id;
    const pageTitle = sel === "all" && t.pageId ? pages.find((p) => p.id === t.pageId)?.title : null;
    return (
      <li
        key={t.id}
        className="rounded-xl border border-transparent hover:border-[var(--line)]"
        draggable={sort === "manual" && t.status !== "done"}
        onDragStart={() => (dragId.current = t.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => void drop(t.id)}
        title={reasons[t.id]}
      >
        <div className="row-hover flex items-center gap-2 rounded-xl px-2 py-1.5">
          <GripVertical size={14} className={`shrink-0 text-[var(--fg-faint)] ${sort === "manual" && t.status !== "done" ? "cursor-grab" : "opacity-0"}`} />
          <button
            aria-label={t.status === "done" ? "Mark as to do" : "Mark as done"}
            className="flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full border-2"
            style={{ borderColor: t.status === "done" ? "var(--ok)" : t.status === "doing" ? "var(--info)" : "var(--fg-faint)", background: t.status === "done" ? "var(--ok)" : "transparent" }}
            onClick={() => void save({ ...t, status: t.status === "done" ? "todo" : "done" })}
          >
            {t.status === "done" && <Check size={11} color="#fff" strokeWidth={3} />}
            {t.status === "doing" && <span className="h-2 w-2 rounded-full bg-[var(--info)]" />}
          </button>
          <button className="min-w-0 flex-1 cursor-pointer truncate text-left text-[13.5px]" style={{ textDecoration: t.status === "done" ? "line-through" : undefined, opacity: t.status === "done" ? 0.55 : 1 }} onClick={() => setOpen(isOpen ? null : t.id)}>
            {t.title}
          </button>
          {pageTitle && <span className="pill">{pageTitle}</span>}
          {t.aiPrompt && <Sparkles size={13} className="shrink-0 text-[var(--accent)]" aria-label="Has AI prompt" />}
          {t.due && <span className="shrink-0 text-xs" style={{ color: t.due < Date.now() && t.status !== "done" ? "var(--bad)" : "var(--fg-faint)" }}>{new Date(t.due).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
          <Dropdown
            items={PRIORITY.map((p, i) => ({ label: p.label, checked: t.priority === i, onClick: () => void save({ ...t, priority: i }) }))}
            width={150}
          >
            <button className="pill cursor-pointer" style={{ ["--pill" as string]: pr.color }}>
              {t.priority === 0 ? "Priority" : pr.label}
            </button>
          </Dropdown>
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Expand" onClick={() => setOpen(isOpen ? null : t.id)}>
            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Delete to-do"
            onClick={async () => {
              if (await confirm(`Delete “${t.title}”?`)) {
                await api.deleteTodo(t.id);
                await reload();
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        {isOpen && <TodoDetail todo={t} project={project} onChange={(n) => void save(n)} onClose={() => setOpen(null)} />}
      </li>
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      {/* pages */}
      <div className="glass h-fit p-2">
        {[
          { id: "all" as Sel, label: "All to-dos", icon: <ListChecks size={15} />, n: counts(() => true) },
          { id: "inbox" as Sel, label: "General", icon: <Inbox size={15} />, n: counts((t) => t.pageId === null) },
        ].map((x) => (
          <button key={x.id} className="tab w-full justify-between" data-active={sel === x.id} onClick={() => setSel(x.id)}>
            <span className="flex items-center gap-2">{x.icon} {x.label}</span>
            <span className="text-xs text-[var(--fg-faint)]">{x.n || ""}</span>
          </button>
        ))}
        {pages.length > 0 && <div className="menu-sep" />}
        {pages.map((p) => (
          <button key={p.id} className="tab w-full justify-between" data-active={sel === p.id} onClick={() => setSel(p.id)}>
            <span className="truncate">{p.title}</span>
            <span className="text-xs text-[var(--fg-faint)]">{counts((t) => t.pageId === p.id) || ""}</span>
          </button>
        ))}
        <div className="menu-sep" />
        <button className="tab w-full" onClick={() => { setRenaming(false); setNewPage(""); }}>
          <FilePlus2 size={15} /> New page
        </button>
      </div>

      {/* list */}
      <div className="flex min-w-0 flex-col gap-4">
        {page && (
          <div className="glass p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">{page.title}</h2>
              <div className="flex gap-1">
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setRenaming(true);
                    setNewPage(page.title);
                  }}
                >
                  Rename
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={async () => {
                    if (await confirm(`Delete the page “${page.title}”? Its to-dos move to General.`)) {
                      await api.deletePage(page.id);
                      setSel("all");
                      await reload();
                    }
                  }}
                >
                  Delete page
                </button>
              </div>
            </div>
            <PageNotes page={page} onSaved={() => void reload()} />
          </div>
        )}

        <div className="glass p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <h3 className="mr-auto text-[13px] font-semibold">
              {sel === "all" ? "All to-dos" : sel === "inbox" ? "General" : page?.title} <span className="font-normal text-[var(--fg-faint)]">· {open_.length} open</span>
            </h3>
            <Segmented value={sort} onChange={setSort} options={[{ value: "manual", label: "Manual" }, { value: "priority", label: "By priority" }]} />
            <button className="btn btn-sm" onClick={prioritize} disabled={aiBusy || open_.length === 0}>
              {aiBusy ? <Spinner size={13} /> : <Sparkles size={13} />} Prioritize with AI
            </button>
          </div>
          <form
            className="mb-2 flex gap-2 px-1"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input className="input" placeholder={`Add a to-do${page ? ` to “${page.title}”` : ""} and press Enter`} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button className="btn btn-primary shrink-0" type="submit" disabled={!draft.trim()}>
              <Plus size={14} /> Add
            </button>
          </form>
          {open_.length === 0 && done.length === 0 ? (
            <Empty icon={<ListChecks size={30} />} title="No to-dos yet">Capture what's next for this project above.</Empty>
          ) : (
            <ul className="flex flex-col gap-0.5">{open_.map(row)}</ul>
          )}
          {done.length > 0 && (
            <div className="mt-2 px-1">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowDone((v) => !v)}>
                {showDone ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Completed ({done.length})
              </button>
              {showDone && <ul className="mt-1 flex flex-col gap-0.5">{done.map(row)}</ul>}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={newPage !== null}
        onClose={() => { setNewPage(null); setRenaming(false); }}
        title={renaming ? "Rename page" : "New page"}
        width={420}
        footer={
          <>
            <button className="btn" onClick={() => { setNewPage(null); setRenaming(false); }}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void createPage()} disabled={!(newPage ?? "").trim()}>{renaming ? "Save" : "Create"}</button>
          </>
        }
      >
        <input
          className="input"
          autoFocus
          placeholder="e.g. Roadmap, Bugs, Ideas, Exam prep"
          value={newPage ?? ""}
          onChange={(e) => setNewPage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void createPage()}
        />
      </Modal>
      {node}
    </div>
  );
}
