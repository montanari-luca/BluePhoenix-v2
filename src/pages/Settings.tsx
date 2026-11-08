import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUpCircle, CheckCircle2, Download, FolderOpen, KeyRound, RefreshCw, Sparkles, Terminal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Field, Segmented, Spinner, Toggle } from "../components/ui";
import { SyncSection } from "../components/SyncSection";
import { openExternal } from "../lib/actions";
import { api, errMsg } from "../lib/api";
import { useStore } from "../lib/store";
import { ACCENTS } from "../lib/theme";
import type { CliStatus, Provider, UpdateInfo } from "../lib/types";

function Section({ id, title, desc, children }: { id: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <section id={id} className="glass p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {desc && <p className="mt-0.5 mb-4 text-[13px] text-[var(--fg-muted)]">{desc}</p>}
      {!desc && <div className="h-3" />}
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div>
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="text-xs text-[var(--fg-faint)]">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ---------- AI ----------

function AiSection() {
  const { settings, setSetting, toast } = useStore();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [keyDraft, setKeyDraft] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const mode = (settings["ai.mode"] ?? "local") as "local" | "cloud";
  const pool = providers.filter((p) => p.local === (mode === "local"));
  const pid = settings[`ai.provider.${mode}`] ?? pool[0]?.id ?? "";
  const prov = providers.find((p) => p.id === pid);
  const baseUrl = settings[`ai.baseUrl.${pid}`] ?? "";
  const model = settings[`ai.model.${pid}`] ?? "";

  useEffect(() => {
    api.providers().then(setProviders).catch(() => undefined);
  }, []);
  useEffect(() => {
    setModels([]);
    setKeyDraft("");
    if (pid) api.secretHas(`ai:${pid}`).then(setHasKey).catch(() => setHasKey(false));
  }, [pid]);

  const fetchModels = useCallback(async () => {
    if (!prov) return;
    setBusy("models");
    try {
      if (prov.local) await api.aiEnsureLocal().catch(() => null);
      const list = await api.aiModels(prov.id, baseUrl || undefined, keyDraft || undefined);
      setModels(list);
      if (list.length && !model) await setSetting(`ai.model.${pid}`, list[0]);
      toast({ kind: "success", title: `${list.length} model${list.length === 1 ? "" : "s"} available` });
    } catch (e) {
      toast({ kind: "error", title: "Could not list models", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }, [prov, baseUrl, keyDraft, model, pid, setSetting, toast]);

  async function saveKey() {
    try {
      await api.secretSet(`ai:${pid}`, keyDraft);
      setHasKey(!!keyDraft);
      setKeyDraft("");
      toast({ kind: "success", title: keyDraft ? "API key saved to your system keychain" : "API key removed" });
    } catch (e) {
      toast({ kind: "error", title: "Could not save the key", detail: errMsg(e) });
    }
  }

  async function test() {
    setBusy("test");
    try {
      const out = await api.aiComplete("You are a connectivity test. Reply with the single word OK.", "ping", 20);
      toast({ kind: "success", title: "The model answered", detail: out.slice(0, 120) });
    } catch (e) {
      toast({ kind: "error", title: "Test failed", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  async function startGguf() {
    const file = await open({ multiple: false, filters: [{ name: "GGUF model", extensions: ["gguf"] }] });
    if (typeof file !== "string") return;
    await setSetting("ai.gguf", file);
    setBusy("gguf");
    try {
      const url = await api.llamaStart(file);
      await setSetting(`ai.baseUrl.${pid}`, url);
      await setSetting(`ai.model.${pid}`, file.split(/[\\/]/).pop() ?? "model");
      toast({ kind: "success", title: "llama.cpp server starting", detail: "Give it a few seconds to load the model, then press Test." });
    } catch (e) {
      toast({ kind: "error", title: "Could not start llama-server", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section id="ai" title="AI" desc="Used for commit messages, to-do prioritising, prompts, changelogs and command scanning. Local models never leave your computer.">
      <div className="flex flex-col gap-4">
        <Segmented
          value={mode}
          onChange={(v) => void setSetting("ai.mode", v)}
          options={[{ value: "local", label: "Local inference" }, { value: "cloud", label: "Cloud provider" }]}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Provider">
            <select className="input" value={pid} onChange={(e) => void setSetting(`ai.provider.${mode}`, e.target.value)}>
              {pool.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Server address" hint={prov ? `Default: ${prov.baseUrl}` : undefined}>
            <input className="input font-mono" placeholder={prov?.baseUrl} value={baseUrl} onChange={(e) => void setSetting(`ai.baseUrl.${pid}`, e.target.value)} />
          </Field>
        </div>

        {prov?.needsKey && (
          <Field label="API key" hint="Stored in your operating system's keychain, never in the app database.">
            <div className="flex gap-2">
              <input className="input font-mono" type="password" placeholder={hasKey ? "•••••••• saved" : "Paste your API key"} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
              <button className="btn shrink-0" onClick={() => void saveKey()} disabled={!keyDraft}>
                <KeyRound size={14} /> Save
              </button>
              {hasKey && (
                <button className="btn shrink-0" onClick={() => void api.secretSet(`ai:${pid}`, "").then(() => setHasKey(false))}>Remove</button>
              )}
            </div>
          </Field>
        )}

        {pid === "llamacpp" && (
          <Field label="GGUF model file" hint="Needs llama.cpp (the llama-server program) installed. Ollama and LM Studio are easier if you do not have it.">
            <div className="flex gap-2">
              <input className="input" readOnly value={settings["ai.gguf"] ?? ""} placeholder="No file selected" />
              <button className="btn shrink-0" onClick={() => void startGguf()} disabled={busy === "gguf"}>
                {busy === "gguf" ? <Spinner size={14} /> : <FolderOpen size={14} />} Choose &amp; start
              </button>
              <button className="btn shrink-0" onClick={() => void api.llamaStop()}>Stop</button>
            </div>
          </Field>
        )}

        {mode === "local" && (pid === "ollama" || pid === "lmstudio") && (
          <div className="flex items-center justify-between gap-6">
            <div>
              <div className="text-[13.5px] font-medium">Start {prov?.name} with BluePhoenix</div>
              <div className="text-xs text-[var(--fg-faint)]">If it is not running when BluePhoenix opens, BluePhoenix starts it for you.</div>
            </div>
            <Toggle checked={(settings["ai.autostart"] ?? "true") === "true"} onChange={(v) => void setSetting("ai.autostart", String(v))} label="Start automatically" />
          </div>
        )}

        <Field label="Model">
          <div className="flex gap-2">
            {models.length > 0 ? (
              <select className="input" value={model} onChange={(e) => void setSetting(`ai.model.${pid}`, e.target.value)}>
                {!models.includes(model) && model && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input className="input font-mono" placeholder="Model name, or press Load models" value={model} onChange={(e) => void setSetting(`ai.model.${pid}`, e.target.value)} />
            )}
            <button className="btn shrink-0" onClick={() => void fetchModels()} disabled={busy === "models"}>
              {busy === "models" ? <Spinner size={14} /> : <RefreshCw size={14} />} Load models
            </button>
            <button className="btn btn-primary shrink-0" onClick={() => void test()} disabled={busy === "test" || !model}>
              {busy === "test" ? <Spinner size={14} /> : <Sparkles size={14} />} Test
            </button>
          </div>
        </Field>
      </div>
    </Section>
  );
}

// ---------- command line ----------

function CliSection() {
  const { toast, system } = useStore();
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.cliStatus().then(setStatus).catch(() => undefined);
  }, []);

  async function run(action: "install" | "uninstall") {
    setBusy(true);
    try {
      const s = await (action === "install" ? api.cliInstall() : api.cliUninstall());
      setStatus(s);
      toast({
        kind: "success",
        title: action === "install" ? "Command line installed" : "Command line removed",
        detail: action === "install" ? "Open a new terminal window to use the bluephoenix command." : undefined,
      });
    } catch (e) {
      toast({ kind: "error", title: action === "install" ? "Could not install the command line" : "Could not remove the command line", detail: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const ready = status?.installed && status.upToDate;
  return (
    <Section id="cli" title="Command line" desc="Use BluePhoenix from any terminal. It installs itself for your user account and needs no administrator rights.">
      <Row
        label="bluephoenix command"
        hint={status?.installed ? (status.upToDate ? status.path ?? undefined : "Out of date. Reinstall to point it at this copy of BluePhoenix.") : "Not installed"}
      >
        <div className="flex items-center gap-2">
          {ready && (
            <span className="flex items-center gap-1.5 text-[13px] text-[var(--ok)]">
              <CheckCircle2 size={15} /> Installed
            </span>
          )}
          <button className="btn" onClick={() => void run("install")} disabled={busy || !status}>
            {busy ? <Spinner size={14} /> : <Terminal size={14} />} {status?.installed ? "Reinstall" : "Install"}
          </button>
          {status?.installed && (
            <button className="btn" onClick={() => void run("uninstall")} disabled={busy}>
              Remove
            </button>
          )}
        </div>
      </Row>
      <div className="divider my-2" />
      <div className="flex flex-col gap-1.5 pt-2 text-[13px]">
        <div>
          <code className="font-mono">bluephoenix commit</code>
          <span className="text-[var(--fg-muted)]"> stages everything, writes the commit message with your AI model and commits. Add </span>
          <code className="font-mono">-push</code>
          <span className="text-[var(--fg-muted)]"> to push too.</span>
        </div>
        <div>
          <code className="font-mono">bluephoenix add</code>
          <span className="text-[var(--fg-muted)]"> adds the current folder as a project.</span>
        </div>
        {system?.platform !== "windows" && status?.installed && !status.onPath && (
          <p className="text-xs text-[var(--fg-faint)]">Add ~/.local/bin to your PATH to use the command.</p>
        )}
      </div>
    </Section>
  );
}

// ---------- updates ----------

function UpdatesSection() {
  const { system, settings, setSetting, setUpdate, toast } = useStore();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState<"check" | "download" | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    const un = listen<{ downloaded: number; total: number | null }>("update-progress", (e) => setProgress(e.payload));
    return () => void un.then((f) => f());
  }, []);

  async function check() {
    setBusy("check");
    try {
      const r = await api.checkUpdate();
      setInfo(r);
      setUpdate(r.available ? { latest: r.latest, downloadUrl: r.downloadUrl } : null);
    } catch (e) {
      toast({ kind: "error", title: "Could not check for updates", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    if (!info?.downloadUrl) return;
    setBusy("download");
    setProgress({ downloaded: 0, total: null });
    try {
      setFile(await api.downloadUpdate(info.downloadUrl));
    } catch (e) {
      toast({ kind: "error", title: "Download failed", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  async function openInstaller(path: string) {
    try {
      await api.installUpdate(path);
    } catch (e) {
      setFile(null);
      toast({ kind: "error", title: "Could not open the installer", detail: errMsg(e) });
    }
  }

  const pct = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;

  return (
    <Section id="updates" title="Updates">
      <Row label="Current version" hint={system?.platform}>
        <span className="font-mono text-[13px]">{system?.version ?? "…"}</span>
      </Row>
      <Row label="Check for updates on launch">
        <Toggle checked={(settings.autoUpdate ?? "true") === "true"} onChange={(v) => void setSetting("autoUpdate", String(v))} label="Check for updates on launch" />
      </Row>
      <div className="divider my-2" />
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button className="btn" onClick={() => void check()} disabled={busy !== null}>
          {busy === "check" ? <Spinner size={14} /> : <RefreshCw size={14} />} Check for updates
        </button>
        {info && !info.available && (
          <span className="flex items-center gap-1.5 text-[13px] text-[var(--ok)]"><CheckCircle2 size={15} /> You're up to date ({info.current})</span>
        )}
        {info?.available && (
          <>
            <span className="flex items-center gap-1.5 text-[13px] font-medium"><ArrowUpCircle size={15} className="text-[var(--accent)]" /> Version {info.latest} is available</span>
            {info.downloadUrl ? (
              !file && (
                <button className="btn btn-primary" onClick={() => void download()} disabled={busy !== null}>
                  {busy === "download" ? <Spinner size={14} /> : <Download size={14} />} Download update
                </button>
              )
            ) : (
              <span className="text-xs text-[var(--fg-faint)]">No installer has been published for this platform yet.</span>
            )}
          </>
        )}
      </div>
      {busy === "download" && (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--hover)]">
          <div className="h-full rounded-full transition-all" style={{ width: pct === null ? "35%" : `${pct}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-2))" }} />
        </div>
      )}
      {file && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-[var(--fg-muted)]">Downloaded to your Downloads folder.</span>
          <button className="btn btn-primary" onClick={() => void openInstaller(file)}>Open installer</button>
          <button className="btn" onClick={() => void api.quit()}>Quit BluePhoenix</button>
        </div>
      )}
    </Section>
  );
}

// ---------- page ----------

export default function Settings() {
  const { settings, setSetting, editors, terminals, system } = useStore();
  const [params] = useSearchParams();
  const section = params.get("section");

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [section]);

  const theme = settings.theme ?? "system";
  const accent = settings.accent ?? "blue";

  return (
    <div className="h-full overflow-y-auto px-6 pb-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-[22px] font-bold tracking-tight">Settings</h1>

        <Section id="appearance" title="Appearance">
          <Row label="Theme" hint="System follows your operating system.">
            <Segmented value={theme as "system"} onChange={(v) => void setSetting("theme", v)} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          </Row>
          <Row label="Accent colour">
            <div className="flex gap-2">
              {Object.entries(ACCENTS).map(([k, a]) => (
                <button
                  key={k}
                  title={a.label}
                  aria-label={a.label}
                  onClick={() => void setSetting("accent", k)}
                  className="h-7 w-7 cursor-pointer rounded-full"
                  style={{ background: `linear-gradient(135deg, ${a.a}, ${a.b})`, outline: accent === k ? "2px solid var(--fg)" : "none", outlineOffset: 2 }}
                />
              ))}
            </div>
          </Row>
        </Section>

        <Section id="tools" title="Editors &amp; terminals">
          <Row label="Default editor" hint="Used by “Open in editor”. Each project can override it.">
            <select className="input !w-56" value={settings.defaultEditor ?? ""} onChange={(e) => void setSetting("defaultEditor", e.target.value)}>
              <option value="">First installed editor</option>
              {editors.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
              <option value="system">System default app</option>
            </select>
          </Row>
          <Row label="Default terminal">
            <select className="input !w-56" value={settings.defaultTerminal ?? "embedded"} onChange={(e) => void setSetting("defaultTerminal", e.target.value)}>
              <option value="embedded">Embedded terminal</option>
              <option value="system">System terminal</option>
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Row>
          <Row label="Run commands in" hint="Where the dashboard “Run” button starts commands.">
            <Segmented value={(settings.runIn ?? "embedded") as "embedded"} onChange={(v) => void setSetting("runIn", v)} options={[{ value: "embedded", label: "Embedded" }, { value: "system", label: "System terminal" }]} />
          </Row>
        </Section>

        <AiSection />
        <SyncSection />
        <CliSection />
        <UpdatesSection />

        <Section id="about" title="About">
          <p className="text-[13px] text-[var(--fg-muted)]">
            BluePhoenix keeps your projects, to-dos and time in one place. Your data is stored locally and only leaves your computer when you enable cloud sync or use a cloud AI provider.
          </p>
          <div className="divider my-4" />
          <div className="flex flex-wrap items-center gap-5">
            <button className="cursor-pointer" onClick={() => openExternal("https://mintflow.dev")} aria-label="Visit mintflow.dev">
              <img src="/brand/mintflow-logo.webp" alt="MintFlow" className="h-10 w-auto" draggable={false} />
            </button>
            <div className="text-[13px]">
              <div className="font-semibold">Developed by MintFlow Technologies</div>
              <div className="text-[var(--fg-muted)]">Lead developer: Luca Montanari</div>
              <button className="mt-0.5 cursor-pointer text-[var(--accent)] hover:underline" onClick={() => openExternal("https://mintflow.dev")}>
                mintflow.dev
              </button>
            </div>
            <div className="ml-auto text-right text-xs text-[var(--fg-faint)]">
              BluePhoenix {system?.version}
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
