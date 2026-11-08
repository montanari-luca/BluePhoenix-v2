import { memo } from "react";
import type { GraphEdge, GraphRow } from "../lib/graph";

/** Branch colours: theme tokens, so they follow the accent and light/dark mode. */
export const GRAPH_PALETTE = ["var(--accent)", "var(--accent-2)", "var(--ok)", "var(--warn)", "var(--info)", "var(--bad)"];
const LANE_W = 12;
/** Wider graphs are clipped so the commit text keeps its room. */
const MAX_LANES = 12;
export const GRAPH_ROW_H = 36;

const color = (i: number) => GRAPH_PALETTE[i % GRAPH_PALETTE.length];
const x = (lane: number) => LANE_W / 2 + lane * LANE_W;

export function graphWidth(lanes: number): number {
  return Math.min(Math.max(lanes, 1), MAX_LANES) * LANE_W;
}

function edgePath(e: GraphEdge, h: number): string {
  const [y1, y2] = e.kind === "in" ? [0, h / 2] : e.kind === "out" ? [h / 2, h] : [0, h];
  const x1 = x(e.from);
  const x2 = x(e.to);
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

/** The graph cell for one history row. One small SVG per row keeps rows independent and cheap. */
export const CommitGraphCell = memo(function CommitGraphCell({ row, width, merge }: { row: GraphRow; width: number; merge: boolean }) {
  const h = GRAPH_ROW_H;
  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} className="shrink-0 overflow-hidden" aria-hidden>
      {row.edges.map((e, i) => (
        <path key={i} d={edgePath(e, h)} stroke={color(e.color)} strokeWidth={1.75} fill="none" strokeLinecap="round" />
      ))}
      <circle
        cx={x(row.lane)}
        cy={h / 2}
        r={merge ? 3 : 3.75}
        fill={merge ? "var(--glass-strong)" : color(row.color)}
        stroke={color(row.color)}
        strokeWidth={merge ? 2 : 0}
      />
    </svg>
  );
});

/**
 * Small labels for the refs git decorates a commit with ("HEAD -> main", "origin/main", "tag: v1").
 * `remotes` holds remote-tracking branch names, which are shown muted.
 */
export function RefLabels({ refs, remotes }: { refs: string[]; remotes: Set<string> }) {
  if (refs.length === 0) return null;
  const shown = refs.slice(0, 3);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((r) => {
        let label = r;
        let tone = "var(--fg-faint)";
        let bold = false;
        if (r.startsWith("HEAD -> ")) {
          label = r.slice(8);
          tone = "var(--accent)";
          bold = true;
        } else if (r.startsWith("tag: ")) {
          label = r.slice(5);
          tone = "var(--warn)";
        } else if (r === "HEAD") {
          tone = "var(--accent)";
          bold = true;
        } else if (!remotes.has(r) && !r.endsWith("/HEAD")) {
          tone = "var(--accent)";
        }
        return (
          <span
            key={r}
            title={r}
            className={`pill !h-[18px] max-w-[160px] !px-1.5 !text-[10.5px] ${bold ? "" : "!font-medium"}`}
            style={{ ["--pill" as string]: tone }}
          >
            <span className="truncate">{label}</span>
          </span>
        );
      })}
      {refs.length > shown.length && (
        <span className="text-[10.5px] text-[var(--fg-faint)]" title={refs.slice(3).join(", ")}>
          +{refs.length - shown.length}
        </span>
      )}
    </span>
  );
}
