import { describe, expect, it } from "vitest";
import { ciState } from "../components/PullRequests";

const run = (status: string, conclusion = "") => ({ status, conclusion, workflowName: "CI", url: "u", headBranch: "main" });

describe("ciState", () => {
  it("names each outcome", () => {
    expect(ciState(null)).toBeNull();
    expect(ciState(run("in_progress"))?.label).toBe("CI running");
    expect(ciState(run("completed", "success"))?.color).toBe("var(--ok)");
    expect(ciState(run("completed", "failure"))?.label).toBe("CI failed");
    expect(ciState(run("completed", "cancelled"))?.label).toBe("CI cancelled");
  });
});
