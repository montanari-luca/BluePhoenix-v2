import { CheckCircle2, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Spinner } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { useStore, logError } from "../../lib/store";
import type { CliStatus } from "../../lib/types";
import { Section, Row } from "./Shared";

export function CliSection() {
  const { toast, system } = useStore();
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.cliStatus().then(setStatus).catch(logError("CLI status"));
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
