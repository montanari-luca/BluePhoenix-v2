import { FileText, Plus, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { AutomationCard } from "../components/AutomationCard";
import { AutomationDialog } from "../components/AutomationDialog";
import { Empty, SplitButton, useConfirm } from "../components/ui";
import { api, errMsg } from "../lib/api";
import { useStore } from "../lib/store";
import type { Automation } from "../lib/types";

type DialogState = { editing: Automation | null; templates: boolean } | null;

export default function Automations() {
  const automations = useStore((s) => s.automations);
  const projects = useStore((s) => s.projects);
  const ready = useStore((s) => s.ready);
  const load = useStore((s) => s.loadAutomations);
  const toast = useStore((s) => s.toast);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [running, setRunning] = useState<string | null>(null);
  const { confirm, node } = useConfirm();

  useEffect(() => {
    void load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const run = async (a: Automation) => {
    setRunning(a.id);
    try {
      const s = await api.runAutomation(a.id);
      const ran = s.ok + s.failed;
      if (ran === 0) {
        toast({
          kind: "info",
          title: `${a.name}: nothing to run`,
          detail: s.skipped.length ? s.skipped.map((x) => `${x.project}: ${x.reason}`).join("\n") : "No matching projects with a folder.",
        });
      } else {
        toast({
          kind: s.failed ? "error" : "success",
          title: s.failed ? `${a.name}: ${s.failed} failed` : `${a.name}: ran on ${ran} project${ran === 1 ? "" : "s"}`,
          detail: s.skipped.length ? `Skipped: ${s.skipped.map((x) => `${x.project} (${x.reason})`).join(", ")}` : undefined,
        });
      }
    } catch (e) {
      toast({ kind: "error", title: "Could not run automation", detail: errMsg(e) });
    } finally {
      setRunning(null);
      await load();
    }
  };

  const toggle = async (a: Automation, enabled: boolean) => {
    try {
      await api.saveAutomation({ ...a, enabled });
    } catch (e) {
      toast({ kind: "error", title: "Could not update automation", detail: errMsg(e) });
    }
    await load();
  };

  const remove = async (a: Automation) => {
    if (!(await confirm(`Remove “${a.name}”? Its run history is deleted too. Your projects are not touched.`))) return;
    try {
      await api.deleteAutomation(a.id);
    } catch (e) {
      toast({ kind: "error", title: "Could not remove automation", detail: errMsg(e) });
    }
    await load();
  };

  const newButton = (
    <SplitButton
      primary
      icon={<Plus size={15} />}
      label="New automation"
      title="Create empty automation"
      onClick={() => setDialog({ editing: null, templates: false })}
      items={[
        { label: "Create empty automation", icon: <Zap size={15} />, onClick: () => setDialog({ editing: null, templates: false }) },
        { label: "Start from a template", icon: <FileText size={15} />, onClick: () => setDialog({ editing: null, templates: true }) },
      ]}
    />
  );

  if (!ready) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 pt-1 pb-4">
        <div className="mr-auto">
          <h1 className="text-[22px] font-bold tracking-tight">Automations</h1>
          <p className="text-[13px] text-[var(--fg-muted)]">
            {automations.length === 0 ? "Nothing here yet" : `${automations.length} automation${automations.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {newButton}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {automations.length === 0 ? (
          <div className="glass mx-auto mt-10 max-w-xl">
            <Empty icon={<Zap size={40} />} title="Automate the chores">
              Run commands in your projects when BluePhoenix launches or quits, on a schedule, or after a commit. Start from a template or build your own.
              <div className="mt-4 flex justify-center">{newButton}</div>
            </Empty>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(350px, 1fr))" }}>
            {automations.map((a) => (
              <AutomationCard
                key={a.id}
                automation={a}
                projects={projects}
                running={running === a.id}
                onRun={() => void run(a)}
                onEdit={() => setDialog({ editing: a, templates: false })}
                onRemove={() => void remove(a)}
                onToggle={(enabled) => void toggle(a, enabled)}
              />
            ))}
          </div>
        )}
      </div>

      <AutomationDialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        editing={dialog?.editing ?? null}
        startWithTemplates={dialog?.templates ?? false}
      />
      {node}
    </div>
  );
}
