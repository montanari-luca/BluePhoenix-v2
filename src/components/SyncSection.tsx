import { listen } from "@tauri-apps/api/event";
import { CloudOff, Database, Link2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useStore, logError } from "../lib/store";
import type { SyncStatus } from "../lib/types";
import { Field, Pill, Segmented, Spinner } from "./ui";

type Kind = "neon" | "other";

const TEMPLATES: Record<Kind, string> = {
  neon: "postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require",
  other: "postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require",
};

export function SyncSection() {
  const toast = useStore((s) => s.toast);
  const loadProjects = useStore((s) => s.loadProjects);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [kind, setKind] = useState<Kind>("neon");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "connect" | "sync" | null>(null);

  const refresh = useCallback(() => api.syncStatus().then(setStatus).catch(logError("sync status")), []);

  useEffect(() => {
    void refresh();
    const subs = [
      listen("sync-finished", () => {
        void refresh();
        void loadProjects();
      }),
      listen("sync-failed", () => void refresh()),
    ];
    return () => subs.forEach((p) => void p.then((f) => f()));
  }, [refresh, loadProjects]);

  async function test() {
    setBusy("test");
    try {
      const v = await api.syncTest(url);
      toast({ kind: "success", title: "Connection works", detail: v });
    } catch (e) {
      toast({ kind: "error", title: "Could not connect", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    setBusy("connect");
    try {
      const r = await api.syncConnect(url);
      setUrl("");
      toast({ kind: "success", title: "Cloud sync is on", detail: `Uploaded ${r.pushed}, downloaded ${r.pulled} item${r.pulled === 1 ? "" : "s"}.` });
      await loadProjects();
    } catch (e) {
      toast({ kind: "error", title: "Could not connect", detail: errMsg(e) });
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  async function syncNow() {
    setBusy("sync");
    try {
      const r = await api.syncNow();
      toast({ kind: "success", title: "Synced", detail: `Uploaded ${r.pushed}, downloaded ${r.pulled}.` });
    } catch (e) {
      toast({ kind: "error", title: "Sync failed", detail: errMsg(e) });
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  return (
    <section id="sync" className="glass p-5">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold">
        Cloud sync
        {status?.connected && <Pill color="var(--ok)">Connected</Pill>}
      </h2>
      <p className="mt-0.5 mb-4 text-[13px] text-[var(--fg-muted)]">
        Keep your projects, to-dos, notes and time in sync between your computers and the iPhone app. You bring your own database; BluePhoenix never sees your data.
      </p>

      {status?.connected ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <Database size={16} className="text-[var(--fg-muted)]" />
            <span className="font-mono">{status.host ?? "database"}</span>
            <span className="text-[var(--fg-faint)]">
              {status.lastSync ? `Last synced ${timeAgo(status.lastSync)}` : "Not synced yet"} · syncs automatically every minute
            </span>
          </div>
          {status.lastError && (
            <p className="selectable rounded-lg bg-[color-mix(in_srgb,var(--bad)_14%,transparent)] px-3 py-2 text-xs text-[var(--bad)]">Last attempt failed: {status.lastError}</p>
          )}
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => void syncNow()} disabled={busy !== null}>
              {busy === "sync" ? <Spinner size={14} /> : <RefreshCw size={14} />} Sync now
            </button>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={async () => {
                await api.syncDisconnect();
                await refresh();
                toast({ kind: "info", title: "Cloud sync disconnected", detail: "Your local data is unchanged. Data already in the database stays there." });
              }}
            >
              <CloudOff size={14} /> Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Segmented value={kind} onChange={setKind} options={[{ value: "neon", label: "Neon (default)" }, { value: "other", label: "Other Postgres" }]} />
          <Field
            label="Database connection string"
            hint={
              kind === "neon"
                ? "Create a free project at neon.tech, then copy the connection string from the dashboard. Both the direct and the pooled connection string work."
                : "Any PostgreSQL 12+ database you can reach, such as Supabase, Railway or your own server."
            }
          >
            <input className="input font-mono" type="password" placeholder={TEMPLATES[kind]} value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <p className="text-xs text-[var(--fg-faint)]">The address contains your password, so it is stored in your system keychain. BluePhoenix creates its own <code>bp_*</code> tables and touches nothing else.</p>
          <div className="flex gap-2">
            <button className="btn" onClick={() => void test()} disabled={!url.trim() || busy !== null}>
              {busy === "test" ? <Spinner size={14} /> : <Link2 size={14} />} Test connection
            </button>
            <button className="btn btn-primary" onClick={() => void connect()} disabled={!url.trim() || busy !== null}>
              {busy === "connect" ? <Spinner size={14} /> : <Database size={14} />} Connect &amp; sync
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
