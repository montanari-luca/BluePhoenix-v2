import { Copy, FileText, ScrollText, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { generateChangelog, generatePrDescription, summarizeChanges } from "../lib/ai";
import { hasFolder } from "../lib/actions";
import { api, errMsg } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useStore, logError, reportError } from "../lib/store";
import type { Commit, Project } from "../lib/types";
import { MarkdownView } from "../components/Markdown";
import { Empty, Spinner } from "../components/ui";

export default function ChangelogTab({ project: p }: { project: Project }) {
  const toast = useStore((s) => s.toast);
  const [tags, setTags] = useState<string[]>([]);
  const [range, setRange] = useState("last:30");
  const [commits, setCommits] = useState<Commit[]>([]);
  const [heading, setHeading] = useState(`Release ${new Date().toISOString().slice(0, 10)}`);
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (range.startsWith("last:")) setCommits(await api.gitLog(p.path, Number(range.slice(5))));
      else setCommits(await api.gitLog(p.path, 500, `${range.slice(6)}..HEAD`));
    } catch (e) {
      setCommits(reportError("Could not read the git history", [])(e));
    }
  }, [p.path, range]);

  useEffect(() => {
    if (hasFolder(p)) api.gitTags(p.path).then(setTags).catch(logError("load tags"));
  }, [p]);
  useEffect(() => {
    if (hasFolder(p)) void load();
  }, [p, load]);

  if (!hasFolder(p)) return <div className="glass"><Empty icon={<ScrollText size={30} />} title="This project has no folder">Changelogs are built from git history.</Empty></div>;

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label);
    try {
      setOut(await fn());
    } catch (e) {
      toast({ kind: "error", title: `${label} failed`, detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
      <div className="glass flex flex-col gap-3 p-4">
        <div>
          <label className="label">Commits to include</label>
          <select className="input" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="last:15">Last 15 commits</option>
            <option value="last:30">Last 30 commits</option>
            <option value="last:100">Last 100 commits</option>
            {tags.map((t) => (
              <option key={t} value={`since:${t}`}>Since {t}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Heading</label>
          <input className="input" value={heading} onChange={(e) => setHeading(e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <button className="btn btn-primary" disabled={!!busy || commits.length === 0} onClick={() => void run("Generate changelog", () => generateChangelog(p, commits, heading))}>
            {busy === "Generate changelog" ? <Spinner size={14} /> : <Sparkles size={14} />} Generate changelog
          </button>
          <button className="btn" disabled={!!busy || commits.length === 0} onClick={() => void run("Summarize changes", () => summarizeChanges(p, commits))}>
            {busy === "Summarize changes" ? <Spinner size={14} /> : <FileText size={14} />} Summarize changes
          </button>
          <button
            className="btn"
            disabled={!!busy || commits.length === 0}
            onClick={() => void run("PR description", async () => generatePrDescription(p, commits, await api.gitDiff(p.path, false).then((d) => d.split("\n").filter((l) => l.startsWith("diff --git")).join("\n")).catch(logError("diff for PR description", ""))))}
          >
            {busy === "PR description" ? <Spinner size={14} /> : <Sparkles size={14} />} Write PR description
          </button>
        </div>
        <div className="divider" />
        <div>
          <div className="label">{commits.length} commit{commits.length === 1 ? "" : "s"} in range</div>
          <ul className="max-h-64 overflow-y-auto text-[13px]">
            {commits.map((c) => (
              <li key={c.hash} className="flex gap-2 py-1" title={formatDateTime(c.ts)}>
                <code className="font-mono text-xs text-[var(--accent)]">{c.short}</code>
                <span className="truncate">{c.subject}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="glass min-h-[300px] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Result</h3>
          {out && (
            <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(out).then(() => toast({ kind: "success", title: "Copied to clipboard" }))}>
              <Copy size={13} /> Copy Markdown
            </button>
          )}
        </div>
        {busy ? (
          <div className="flex items-center gap-2 py-10 text-[13px] text-[var(--fg-muted)]"><Spinner /> {busy}…</div>
        ) : out ? (
          <MarkdownView text={out} />
        ) : (
          <Empty icon={<ScrollText size={30} />} title="Nothing generated yet">
            Choose a range and let the AI write release notes or summarize what changed.
          </Empty>
        )}
      </div>
    </div>
  );
}
