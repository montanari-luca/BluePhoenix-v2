import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, KeyRound, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Field, Segmented, Spinner, Toggle } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { useStore, logError, reportError } from "../../lib/store";
import type { Provider } from "../../lib/types";
import { Section } from "./Shared";

export function AiSection() {
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
    api.providers().then(setProviders).catch(reportError("Could not load the AI providers"));
  }, []);
  useEffect(() => {
    setModels([]);
    setKeyDraft("");
    if (pid) api.secretHas(`ai:${pid}`).then(setHasKey).catch((e) => setHasKey(logError("keychain lookup", false)(e)));
  }, [pid]);

  const fetchModels = useCallback(async () => {
    if (!prov) return;
    setBusy("models");
    try {
      if (prov.local) await api.aiEnsureLocal().catch(logError("start local AI", null));
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
