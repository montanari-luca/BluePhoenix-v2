import { open, save } from "@tauri-apps/plugin-dialog";
import { DatabaseBackup, Download, FolderOpen, History, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { logError, useStore } from "../../lib/store";
import type { BackupFile, ImportReport } from "../../lib/types";
import { Row, Section } from "./Shared";

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const imported = (r: ImportReport) =>
  r.changed === 0 ? "Everything in it was already here." : `${r.changed} item${r.changed === 1 ? "" : "s"} added or brought up to date.`;

export function BackupSection() {
  const toast = useStore((s) => s.toast);
  const loadProjects = useStore((s) => s.loadProjects);
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, node } = useConfirm();

  const refresh = useCallback(() => api.backupList().then(setFiles).catch(logError("list backups")), []);
  useEffect(() => void refresh(), [refresh]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast({ kind: "error", title: `${label} failed`, detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  const exportTo = () =>
    run("Export", async () => {
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await save({
        title: "Export BluePhoenix data",
        defaultPath: `BluePhoenix-${stamp}.json`,
        filters: [
          { name: "BluePhoenix backup (JSON)", extensions: ["json"] },
          { name: "SQLite database copy", extensions: ["db"] },
        ],
      });
      if (!path) return;
      await api.backupExport(path);
      toast({ kind: "success", title: "Exported", detail: path });
    });

  const importFrom = async (path?: string) => {
    const file =
      path ??
      (await open({
        title: "Import a BluePhoenix backup",
        multiple: false,
        filters: [{ name: "BluePhoenix backup", extensions: ["json", "db"] }],
      }));
    if (typeof file !== "string") return;
    const ok = await confirm(
      "Bring in everything from this backup? Missing items are added and older ones updated. Nothing newer than the backup is overwritten.",
    );
    if (!ok) return;
    await run("Import", async () => {
      const r = await api.backupImport(file);
      await loadProjects();
      toast({ kind: "success", title: "Imported", detail: imported(r) });
    });
  };

  const backupNow = () =>
    run("Backup", async () => {
      await api.backupNow();
      await refresh();
      toast({ kind: "success", title: "Backup saved" });
    });

  const openFolder = () => run("Open folder", async () => api.reveal(await api.backupDir()));

  return (
    <Section id="backup" title="Backup" desc="BluePhoenix keeps a copy of your data every day (the last 7). You can also export it to a file and import it on any computer.">
      <Row label="Export your data" hint="Projects, to-dos, notes, time, commands, automations and settings. Keys stay in your keychain.">
        <button className="btn" disabled={!!busy} onClick={() => void exportTo()}>
          <Download size={15} /> Export…
        </button>
      </Row>
      <Row label="Import a backup" hint="A BluePhoenix .json export or .db copy. Merges with what is here.">
        <button className="btn" disabled={!!busy} onClick={() => void importFrom()}>
          <Upload size={15} /> Import…
        </button>
      </Row>
      <div className="divider my-3" />
      <div className="flex items-center justify-between gap-3 pb-2">
        <div className="text-[13.5px] font-medium">Automatic backups</div>
        <div className="flex gap-2">
          <button className="btn btn-sm" disabled={!!busy} onClick={() => void backupNow()}>
            <DatabaseBackup size={14} /> Back up now
          </button>
          <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => void openFolder()}>
            <FolderOpen size={14} /> Show folder
          </button>
        </div>
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-[var(--fg-faint)]">The first one is taken a minute after BluePhoenix starts.</p>
      ) : (
        <ul className="flex flex-col">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--hover)]">
              <History size={14} className="shrink-0 text-[var(--fg-faint)]" />
              <span className="min-w-0 flex-1 truncate">{f.name.replace(/^bluephoenix-|\.db$/g, "")}</span>
              <span className="text-xs text-[var(--fg-faint)]">
                {timeAgo(f.createdAt)} · {size(f.size)}
              </span>
              <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => void importFrom(f.path)}>
                Restore…
              </button>
            </li>
          ))}
        </ul>
      )}
      {node}
    </Section>
  );
}
