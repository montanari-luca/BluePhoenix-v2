import { GitFork, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errMsg } from "../lib/api";
import { describeInterval, forkCanPull, forkLabel, forkPredictionNotice, forkTone, INTERVAL_PRESETS, MIN_INTERVAL_MINUTES, splitInterval, toMinutes, type IntervalUnit } from "../lib/fork";
import { timeAgo, toneColor } from "../lib/format";
import { useStore } from "../lib/store";
import type { ForkSync, Project } from "../lib/types";
import { Field, Pill, Spinner, Toggle } from "./ui";

const CUSTOM = "custom";

/** Check interval: a few presets plus any custom number of minutes, hours or days. */
function IntervalPicker({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const isPreset = INTERVAL_PRESETS.some((p) => p.minutes === minutes);
  const [custom, setCustom] = useState(!isPreset);
  const split = splitInterval(minutes);
  const [amount, setAmount] = useState(String(split.amount));
  const [unit, setUnit] = useState<IntervalUnit>(split.unit);

  const apply = (a: string, u: IntervalUnit) => {
    setAmount(a);
    setUnit(u);
    const n = parseFloat(a);
    if (Number.isFinite(n) && n > 0) onChange(toMinutes(n, u));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="input !w-auto"
        value={custom ? CUSTOM : String(minutes)}
        aria-label="Check interval"
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            apply(amount, unit);
          } else {
            setCustom(false);
            onChange(Number(e.target.value));
          }
        }}
      >
        {INTERVAL_PRESETS.map((p) => (
          <option key={p.minutes} value={p.minutes}>
            {p.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <>
          <span className="text-[13px] text-[var(--fg-muted)]">Every</span>
          <input
            className="input !w-20"
            type="number"
            min={1}
            value={amount}
            aria-label="Interval length"
            onChange={(e) => apply(e.target.value, unit)}
          />
          <select className="input !w-auto" value={unit} aria-label="Interval unit" onChange={(e) => apply(amount, e.target.value as IntervalUnit)}>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </>
      )}
    </div>
  );
}

/** The "this is a GitHub fork" switch and the options that appear with it (used in the project dialog). */
export function ForkSettings({ value, onChange }: { value: ForkSync; onChange: (v: ForkSync) => void }) {
  const set = (patch: Partial<ForkSync>) => onChange({ ...value, ...patch });
  return (
    <div className="rounded-xl border border-[var(--line)] p-3.5">
      <div className="flex items-center gap-3">
        <GitFork size={16} className="shrink-0 text-[var(--fg-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">This project is a GitHub fork</div>
          <p className="text-xs text-[var(--fg-faint)]">Keep an eye on the original repository (upstream) and see when it has new commits.</p>
        </div>
        <Toggle checked={value.isFork} onChange={(isFork) => set({ isFork })} label="GitHub fork" />
      </div>

      {value.isFork && (
        <div className="mt-3.5 flex flex-col gap-3.5 border-t border-[var(--line)] pt-3.5">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Check for upstream changes automatically</div>
              <p className="text-xs text-[var(--fg-faint)]">Runs in the background while BluePhoenix is open. Nothing is changed unless you turn on pulling.</p>
            </div>
            <Toggle checked={value.autoCheck} onChange={(autoCheck) => set({ autoCheck })} label="Check automatically" />
          </div>

          {value.autoCheck && (
            <>
              <Field label="How often" hint={`At least every ${MIN_INTERVAL_MINUTES} minutes.`}>
                <IntervalPicker minutes={value.intervalMinutes} onChange={(intervalMinutes) => set({ intervalMinutes })} />
              </Field>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">Pull when it is safe</div>
                  <p className="text-xs text-[var(--fg-faint)]">
                    Merges new upstream commits only if they do not conflict and you have no uncommitted changes. Conflicting changes are only flagged.
                  </p>
                </div>
                <Toggle checked={value.autoPull} onChange={(autoPull) => set({ autoPull })} label="Pull automatically" />
              </div>
            </>
          )}

          <details>
            <summary className="cursor-pointer text-xs text-[var(--fg-muted)]">Upstream remote</summary>
            <div className="mt-2.5 grid grid-cols-2 gap-3">
              <Field label="Remote name">
                <input className="input" value={value.upstreamRemote} onChange={(e) => set({ upstreamRemote: e.target.value })} />
              </Field>
              <Field label="Branch" hint="Empty: the branch you have checked out.">
                <input className="input" value={value.upstreamBranch ?? ""} placeholder="main" onChange={(e) => set({ upstreamBranch: e.target.value })} />
              </Field>
              <div className="col-span-2">
                <Field label="Upstream URL" hint="Only needed if the remote does not exist yet; BluePhoenix adds it for you.">
                  <input
                    className="input"
                    value={value.upstreamUrl ?? ""}
                    placeholder="https://github.com/original-owner/repo.git"
                    onChange={(e) => set({ upstreamUrl: e.target.value })}
                  />
                </Field>
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/** Upstream status with "Check now" / "Pull" (shown on the Git tab of a fork). */
export function ForkStatusCard({ project: p }: { project: Project }) {
  const fork = useStore((s) => s.forks[p.id]);
  const setForks = useStore((s) => s.setForks);
  const refreshStatus = useStore((s) => s.refreshStatus);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<"check" | "pull" | null>(null);

  useEffect(() => {
    api.forkGet(p.id).then((f) => setForks([f])).catch(() => undefined);
  }, [p.id, setForks]);

  if (!fork?.isFork) return null;

  async function run(pull: boolean) {
    setBusy(pull ? "pull" : "check");
    try {
      const r = await api.checkFork(p.id, pull);
      setForks([r]);
      if (pull) await refreshStatus(p.id);
      if (r.status === "error") toast({ kind: "error", title: "Upstream check failed", detail: r.message ?? undefined });
    } catch (e) {
      toast({ kind: "error", title: "Upstream check failed", detail: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  const remote = `${fork.upstreamRemote}/${fork.upstreamBranch || "…"}`;
  const canPull = forkCanPull(fork);
  const notice = forkPredictionNotice(fork);
  return (
    <div className="glass flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
      <GitFork size={17} className="shrink-0 text-[var(--fg-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold">Upstream</span>
          <code className="font-mono text-xs text-[var(--fg-muted)]">{remote}</code>
          <Pill color={toneColor(forkTone(fork.status))}>{forkLabel(fork)}</Pill>
        </div>
        <p className="mt-0.5 text-xs text-[var(--fg-faint)]">
          {fork.message ? `${fork.message} ` : ""}
          {fork.lastCheck ? `Checked ${timeAgo(fork.lastCheck)}. ` : ""}
          {fork.autoCheck
            ? `Checks ${describeInterval(fork.intervalMinutes)}${fork.autoPull ? " and pulls safe changes" : ""}.`
            : "Automatic checks are off. Turn them on in Edit project."}
        </p>
        {notice && (
          <p className="mt-1 text-xs" style={{ color: toneColor("warn") }}>
            {notice} Pull upstream still tries the merge, but only into a clean working tree, and undoes it if it conflicts.
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button className="btn btn-sm" onClick={() => void run(false)} disabled={busy !== null}>
          {busy === "check" ? <Spinner size={13} /> : <RefreshCw size={13} />} Check now
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => void run(true)}
          disabled={busy !== null || !canPull}
          title={notice && canPull ? "Try the merge; it is undone if it conflicts" : canPull ? "Merge the new upstream commits" : "Nothing safe to pull"}
        >
          {busy === "pull" && <Spinner size={13} />} Pull upstream
        </button>
      </div>
    </div>
  );
}
