import { describe, expect, it } from "vitest";
import { pool } from "./pool";

describe("pool", () => {
  it("never runs more than the limit at once and visits every item in order", async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      started.push(n);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBe(3);
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("handles an empty list", async () => {
    await expect(pool([], 4, async () => undefined)).resolves.toBeUndefined();
  });
});
