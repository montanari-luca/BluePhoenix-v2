import { describe, expect, it } from "vitest";
import { describeInterval, forkLabel, splitInterval, toMinutes } from "./fork";

describe("interval helpers", () => {
  it("splits minutes into the largest even unit", () => {
    expect(splitInterval(1440)).toEqual({ amount: 1, unit: "days" });
    expect(splitInterval(2880)).toEqual({ amount: 2, unit: "days" });
    expect(splitInterval(90)).toEqual({ amount: 90, unit: "minutes" });
    expect(splitInterval(360)).toEqual({ amount: 6, unit: "hours" });
  });

  it("converts back and enforces the minimum", () => {
    expect(toMinutes(2, "days")).toBe(2880);
    expect(toMinutes(3, "hours")).toBe(180);
    expect(toMinutes(1, "minutes")).toBe(15);
    expect(toMinutes(Number.NaN, "hours")).toBe(15);
  });

  it("describes presets and custom intervals", () => {
    expect(describeInterval(1440)).toBe("every 24 hours");
    expect(describeInterval(2880)).toBe("every 2 days");
    expect(describeInterval(10080)).toBe("every week");
    expect(describeInterval(45)).toBe("every 45 minutes");
  });
});

describe("forkLabel", () => {
  it("pluralises commits", () => {
    expect(forkLabel({ status: "safe", behind: 1 })).toBe("1 upstream commit · safe to pull");
    expect(forkLabel({ status: "conflicting", behind: 3 })).toBe("3 upstream commits · conflicting");
    expect(forkLabel({ status: null, behind: 0 })).toBe("Not checked yet");
  });
});
