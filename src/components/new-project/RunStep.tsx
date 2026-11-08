import { Circle, CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { RefObject } from "react";
import type { Step } from "../../lib/initializer";
import type { InitResult } from "../../lib/types";
import { Spinner } from "../ui";
import type { StepState } from "./shared";

export interface RunStepProps {
  plan: Step[];
  states: StepState[];
  log: { step: number; line: string }[];
  logRef: RefObject<HTMLDivElement | null>;
  result: InitResult | null;
  registering: boolean;
}

/** Step 3: the plan running, with live status per step and the output log. */
export function RunStep({ plan, states, log, logRef, result, registering }: RunStepProps) {
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-1">
        {plan.map((s, i) => {
          const st = states[i]?.status ?? "pending";
          return (
            <li key={i} className="flex items-start gap-2.5 text-[13px]">
              <span className="mt-0.5 w-4 shrink-0">
                {st === "running" ? (
                  <Spinner size={14} />
                ) : st === "ok" ? (
                  <CircleCheck size={15} className="text-[var(--ok,#16a34a)]" />
                ) : st === "warn" ? (
                  <TriangleAlert size={15} className="text-[var(--warn,#d97706)]" />
                ) : st === "error" ? (
                  <CircleAlert size={15} className="text-[var(--danger,#dc2626)]" />
                ) : (
                  <Circle size={14} className="text-[var(--fg-faint)]" />
                )}
              </span>
              <span className="min-w-0">
                <span className={st === "pending" ? "text-[var(--fg-faint)]" : ""}>{s.label}</span>
                {(st === "warn" || st === "error") && states[i]?.note && (
                  <span className={`block text-xs ${st === "error" ? "text-[var(--danger,#dc2626)]" : "text-[var(--fg-muted)]"}`}>{states[i].note}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <div ref={logRef} className="max-h-52 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--hover)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--fg-muted)]">
        {log.length === 0 ? "Waiting for output…" : log.map((l, i) => <div key={i}>{l.line}</div>)}
      </div>
      {result && !result.ok && (
        <p className="text-[13px] text-[var(--danger,#dc2626)]">
          {result.cancelled ? "Cancelled. Files created so far were left in the folder." : (result.error ?? "Something went wrong.")}
        </p>
      )}
      {registering && (
        <p className="flex items-center gap-2 text-[13px] text-[var(--fg-muted)]">
          <Spinner size={14} /> Adding the project to BluePhoenix…
        </p>
      )}
    </div>
  );
}
