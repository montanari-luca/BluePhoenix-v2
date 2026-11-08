import { CircleDot, ExternalLink, GitPullRequest, GitPullRequestDraft, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { openExternal } from "../lib/actions";
import { api, errMsg } from "../lib/api";
import { timeAgo } from "../lib/format";
import { logError, useStore } from "../lib/store";
import type { CiRun, GithubStatus, Project } from "../lib/types";
import { Pill, Spinner } from "./ui";

/** Colour and words for the latest workflow run. */
export function ciState(ci: CiRun | null | undefined): { label: string; color: string } | null {
  if (!ci) return null;
  if (ci.status !== "completed") return { label: "CI running", color: "var(--info)" };
  switch (ci.conclusion) {
    case "success":
      return { label: "CI passed", color: "var(--ok)" };
    case "failure":
    case "timed_out":
    case "startup_failure":
      return { label: "CI failed", color: "var(--bad)" };
    case "cancelled":
    case "skipped":
      return { label: `CI ${ci.conclusion}`, color: "var(--fg-faint)" };
    default:
      return { label: `CI ${ci.conclusion || "done"}`, color: "var(--warn)" };
  }
}

const REVIEW: Record<string, { label: string; color: string }> = {
  APPROVED: { label: "Approved", color: "var(--ok)" },
  CHANGES_REQUESTED: { label: "Changes requested", color: "var(--bad)" },
  REVIEW_REQUIRED: { label: "Review required", color: "var(--warn)" },
};

/** One line for the dashboard card: open PRs, reviews waiting for you, CI. Nothing when not on GitHub. */
export function GithubBadges({ status }: { status: GithubStatus | undefined }) {
  if (!status?.available) return null;
  const ci = ciState(status.ci);
  const open = status.pulls.length;
  const mine = status.reviewRequested.length;
  if (!open && !ci) return null;
  return (
    <li className="flex items-center gap-2">
      <GitPullRequest size={14} />
      <span className="truncate">
        {open} open PR{open === 1 ? "" : "s"}
        {mine > 0 && <span style={{ color: "var(--warn)" }}> · {mine} need{mine === 1 ? "s" : ""} your review</span>}
      </span>
      {ci && (
        <button
          className="ml-auto flex shrink-0 items-center gap-1 text-xs hover:underline"
          style={{ color: ci.color }}
          title={status.ci?.workflowName}
          onClick={(e) => {
            e.stopPropagation();
            openExternal(status.ci?.url);
          }}
        >
          <CircleDot size={11} /> {ci.label}
        </button>
      )}
    </li>
  );
}

/** Git tab card: open pull requests and the latest CI run, via the GitHub CLI. */
export function PullRequestsCard({ project: p }: { project: Project }) {
  const status = useStore((s) => s.github[p.id]);
  const setGithub = useStore((s) => s.setGithub);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.githubStatus(p.id).then((s) => setGithub([s])).catch(logError("GitHub status"));
  }, [p.id, setGithub]);

  async function refresh() {
    setBusy(true);
    try {
      setGithub([await api.githubStatus(p.id, true)]);
    } catch (e) {
      toast({ kind: "error", title: "Could not reach GitHub", detail: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  // Not a GitHub repository: nothing to show.
  if (!status || status.reason === "no-remote") return null;
  if (!status.available) {
    return (
      <div className="glass flex items-center gap-3 p-4 text-[13px] text-[var(--fg-muted)]">
        <GitPullRequest size={16} className="shrink-0" />
        <span className="flex-1">{status.message}</span>
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void refresh()}>
          {busy ? <Spinner size={13} /> : <RefreshCw size={13} />} Try again
        </button>
      </div>
    );
  }

  const ci = ciState(status.ci);
  return (
    <div className="glass p-4">
      <div className="flex items-center gap-2">
        <GitPullRequest size={16} className="text-[var(--fg-muted)]" />
        <span className="text-[13px] font-semibold">Pull requests</span>
        <span className="text-xs text-[var(--fg-faint)]">{status.pulls.length} open</span>
        {ci && (
          <button className="ml-2 flex items-center gap-1 text-xs hover:underline" style={{ color: ci.color }} onClick={() => openExternal(status.ci?.url)}>
            <CircleDot size={11} /> {ci.label}
            {status.ci?.workflowName ? ` · ${status.ci.workflowName}` : ""}
            {status.ci?.headBranch ? ` on ${status.ci.headBranch}` : ""}
          </button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-[var(--fg-faint)]">{timeAgo(status.checkedAt)}</span>
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Refresh pull requests" disabled={busy} onClick={() => void refresh()}>
          {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </button>
      </div>
      {status.pulls.length > 0 && (
        <ul className="mt-2 flex flex-col">
          {status.pulls.map((pr) => {
            const review = pr.reviewDecision ? REVIEW[pr.reviewDecision] : undefined;
            const mine = status.reviewRequested.includes(pr.number);
            return (
              <li key={pr.number}>
                <button className="row-hover flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px]" onClick={() => openExternal(pr.url)}>
                  {pr.isDraft ? (
                    <GitPullRequestDraft size={14} className="shrink-0 text-[var(--fg-faint)]" />
                  ) : (
                    <GitPullRequest size={14} className="shrink-0 text-[var(--ok)]" />
                  )}
                  <span className="text-[var(--fg-faint)]">#{pr.number}</span>
                  <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                  {mine && <Pill color="var(--warn)">Your review</Pill>}
                  {pr.isDraft && <Pill>Draft</Pill>}
                  {review && <Pill color={review.color}>{review.label}</Pill>}
                  <span className="hidden shrink-0 text-xs text-[var(--fg-faint)] md:inline">
                    {pr.author?.login} · {pr.headRefName}
                  </span>
                  <ExternalLink size={12} className="shrink-0 text-[var(--fg-faint)]" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
