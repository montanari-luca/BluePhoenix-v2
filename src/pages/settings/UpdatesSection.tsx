import { listen } from "@tauri-apps/api/event";
import { ArrowUpCircle, CheckCircle2, Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Spinner, Toggle } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { useStore } from "../../lib/store";
import type { UpdateInfo } from "../../lib/types";
import { Section, Row } from "./Shared";

export function UpdatesSection() {
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
