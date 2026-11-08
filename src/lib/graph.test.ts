import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphCommit, type GraphEdge, type GraphRow } from "./graph";

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });
const lanes = (rows: GraphRow[]) => rows.map((r) => r.lane);
const kinds = (r: GraphRow, kind: GraphEdge["kind"]) =>
  r.edges.filter((e) => e.kind === kind).map((e) => [e.from, e.to]).sort();

/** The lanes leaving the bottom of a row must be the ones entering the next row. */
function expectContinuous(rows: GraphRow[]) {
  for (let i = 0; i + 1 < rows.length; i++) {
    const bottom = new Set(rows[i].edges.filter((e) => e.kind !== "in").map((e) => e.to));
    const top = new Set(rows[i + 1].edges.filter((e) => e.kind !== "out").map((e) => e.from));
    expect([...top].sort()).toEqual([...bottom].sort());
  }
}

describe("layoutGraph", () => {
  it("keeps linear history in one lane", () => {
    const g = layoutGraph([c("d", "c"), c("c", "b"), c("b", "a"), c("a")]);
    expect(lanes(g.rows)).toEqual([0, 0, 0, 0]);
    expect(g.width).toBe(1);
    expect(g.rows[0].edges).toEqual([{ kind: "out", from: 0, to: 0, color: 0 }]);
    expect(g.rows[3].edges).toEqual([{ kind: "in", from: 0, to: 0, color: 0 }]);
    expect(new Set(g.rows.map((r) => r.color))).toEqual(new Set([0]));
    expectContinuous(g.rows);
  });

  it("forks a lane for a merged branch and collapses it at the fork point", () => {
    // m merges feature (b) into main (c); both branched from a.
    const g = layoutGraph([c("m", "c", "b"), c("b", "a"), c("c", "a"), c("a")]);
    expect(lanes(g.rows)).toEqual([0, 1, 0, 0]);
    expect(g.width).toBe(2);
    expect(kinds(g.rows[0], "out")).toEqual([[0, 0], [0, 1]]);
    expect(kinds(g.rows[1], "pass")).toEqual([[0, 0]]);
    expect(kinds(g.rows[2], "pass")).toEqual([[1, 1]]);
    // a: both lanes converge, then only one lane is left.
    expect(kinds(g.rows[3], "in")).toEqual([[0, 0], [1, 0]]);
    expect(g.rows[3].width).toBe(2);
    expect(g.rows[1].color).not.toBe(g.rows[0].color);
    expect(g.rows[2].color).toBe(g.rows[0].color);
    expectContinuous(g.rows);
  });

  it("handles an octopus merge and separate branch tips", () => {
    const g = layoutGraph([
      c("t", "x"), // unmerged tip of another branch
      c("m", "a", "b", "d"), // octopus
      c("d", "x"),
      c("b", "x"),
      c("a", "x"),
      c("x"),
    ]);
    expect(lanes(g.rows)).toEqual([0, 1, 3, 2, 1, 0]);
    expect(kinds(g.rows[1], "out")).toEqual([[1, 1], [1, 2], [1, 3]]);
    expect(g.width).toBe(4);
    expect(kinds(g.rows[5], "in")).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    // Each branch gets its own colour.
    expect(new Set(g.rows.slice(0, 4).map((r) => r.color)).size).toBe(4);
    expectContinuous(g.rows);
  });

  it("joins a merge parent that another lane is already waiting for", () => {
    // f2 and m both point at f1; the merge reuses f2's lane instead of opening a third.
    const g = layoutGraph([c("f2", "f1"), c("m", "c", "f1"), c("f1", "c"), c("c")]);
    expect(lanes(g.rows)).toEqual([0, 1, 0, 0]);
    expect(kinds(g.rows[1], "out")).toEqual([[1, 0], [1, 1]]);
    expect(g.width).toBe(2);
    expectContinuous(g.rows);
  });

  it("leaves lanes open when history is truncated mid-branch", () => {
    // Only the newest commits are loaded; neither branch reaches its fork point.
    const g = layoutGraph([c("m", "c", "b"), c("b", "b0"), c("c", "c0")]);
    expect(lanes(g.rows)).toEqual([0, 1, 0]);
    const last = g.rows[2];
    expect(kinds(last, "out")).toEqual([[0, 0]]);
    expect(kinds(last, "pass")).toEqual([[1, 1]]);
    expectContinuous(g.rows);
  });

  it("reuses a freed column for a new branch tip", () => {
    const g = layoutGraph([c("m", "c", "b"), c("b", "a"), c("c", "a"), c("a"), c("z", "y"), c("y")]);
    expect(lanes(g.rows)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(g.rows[4].width).toBe(1);
  });

  it("lets a merge parent take a column freed in the same row", () => {
    // At m, lane 1 (x's branch) converges into m and is reused for m's second parent q.
    const g = layoutGraph([c("m0", "m"), c("x", "m"), c("m", "p", "q"), c("q", "p"), c("p")]);
    expect(lanes(g.rows)).toEqual([0, 1, 0, 1, 0]);
    expect(kinds(g.rows[2], "in")).toEqual([[0, 0], [1, 0]]);
    expect(kinds(g.rows[2], "out")).toEqual([[0, 0], [0, 1]]);
    expect(g.width).toBe(2);
    expectContinuous(g.rows);
  });

  it("gives a new branch a colour no open lane is using", () => {
    // Palette of 3: m (0) forks b (1); the tip t opens while both are on screen, so it gets 2.
    const g = layoutGraph([c("m", "a", "b"), c("t", "z"), c("b", "a"), c("a"), c("z")], 3);
    expect(g.rows.map((r) => r.color)).toEqual([0, 2, 1, 0, 2]);
    const g2 = layoutGraph([c("m", "a", "b"), c("b", "a"), c("a"), c("x", "y"), c("y", "w", "v"), c("v"), c("w")], 2);
    // x starts after everything closed: wraps to colour 0; v must avoid x's colour.
    expect(g2.rows[3].color).toBe(0);
    expect(g2.rows[5].color).toBe(1);
  });

  it("returns nothing for an empty history", () => {
    expect(layoutGraph([])).toEqual({ rows: [], width: 0 });
  });
});
