// Lays out a commit history as a lane graph (like `git log --graph`).
//
// Commits must be ordered children-before-parents (git log --date-order or
// --topo-order). Each row is self-contained: it describes the segments drawn
// inside that row, so rows can be rendered independently (and virtualised).
// The lanes leaving the bottom of row i are exactly the lanes entering the top
// of row i + 1, so the segments join up.

export interface GraphCommit {
  hash: string;
  parents: string[];
}

/**
 * A segment inside one row. x values are lane indexes; y is 0 (top of the
 * row), 0.5 (the commit dot) or 1 (bottom of the row).
 * - "in": a lane coming from above into this row's commit.
 * - "out": from this row's commit down to one of its parents' lanes.
 * - "pass": a lane that runs through the row without touching the commit.
 */
export interface GraphEdge {
  kind: "in" | "out" | "pass";
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  /** Lane of the commit dot. */
  lane: number;
  /** Colour index of the commit dot (0 … paletteSize - 1). */
  color: number;
  /** Number of lanes this row touches (for sizing). */
  width: number;
  edges: GraphEdge[];
}

export interface Graph {
  rows: GraphRow[];
  /** Widest row, in lanes. */
  width: number;
}

/**
 * @param paletteSize how many colours the caller cycles through; a new lane
 *   gets the next colour not already used by an open lane, when there is one.
 */
export function layoutGraph(commits: GraphCommit[], paletteSize = 6): Graph {
  // lanes[i] = hash of the commit lane i is waiting for (null = free slot).
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const newColor = () => {
    const used = new Set(colors.filter((_, i) => lanes[i] !== null));
    let k = 0;
    while (k < paletteSize && used.has((nextColor + k) % paletteSize)) k++;
    const col = (nextColor + (k < paletteSize ? k : 0)) % paletteSize;
    nextColor = col + 1;
    return col;
  };
  let maxWidth = 0;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const before = lanes.slice();
    const edges: GraphEdge[] = [];

    // Every lane waiting for this commit converges into its dot.
    const waiting: number[] = [];
    before.forEach((h, i) => h === c.hash && waiting.push(i));

    let lane: number;
    let color: number;
    if (waiting.length > 0) {
      lane = waiting[0];
      color = colors[lane];
      for (const i of waiting) {
        edges.push({ kind: "in", from: i, to: lane, color: colors[i] });
        lanes[i] = null;
      }
    } else {
      // A branch tip (or the first row): take the first free slot.
      lane = freeSlot(lanes);
      color = newColor();
    }

    // Lanes not involved with this commit pass straight through.
    before.forEach((h, i) => {
      if (h !== null && h !== c.hash) edges.push({ kind: "pass", from: i, to: i, color: colors[i] });
    });

    // First parent continues the commit's lane.
    const [first, ...rest] = c.parents;
    if (first !== undefined) {
      lanes[lane] = first;
      colors[lane] = color;
      edges.push({ kind: "out", from: lane, to: lane, color });
    } else {
      lanes[lane] = null; // root commit: the lane ends here
    }

    // Extra parents (merges) join a lane already waiting for them, or fork a new one.
    for (const p of rest) {
      let j = lanes.indexOf(p);
      if (j === -1) {
        j = freeSlot(lanes);
        lanes[j] = p;
        colors[j] = newColor();
      }
      edges.push({ kind: "out", from: lane, to: j, color: colors[j] });
    }

    // Drop free slots at the right edge so the graph narrows again.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }

    const width = Math.max(before.length, lanes.length, lane + 1);
    maxWidth = Math.max(maxWidth, width);
    rows.push({ lane, color, width, edges });
  }

  return { rows, width: maxWidth };
}

/** First free column (one freed earlier in the same row counts), or a new one on the right. */
function freeSlot(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  if (i !== -1) return i;
  lanes.push(null);
  return lanes.length - 1;
}
