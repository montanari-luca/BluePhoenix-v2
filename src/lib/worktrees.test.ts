import { describe, expect, it } from "vitest";
import { suggestedDir } from "../components/Worktrees";

describe("suggestedDir", () => {
  it("puts the worktree next to the repository, named after the branch", () => {
    expect(suggestedDir("/Users/me/Dev/app", "feature/login")).toBe("/Users/me/Dev/app-feature-login");
    expect(suggestedDir("/Users/me/Dev/app/", "origin/hotfix")).toBe("/Users/me/Dev/app-hotfix");
    expect(suggestedDir("C:\\Code\\app", "fix")).toBe("C:\\Code\\app-fix");
    expect(suggestedDir("/x/app", "")).toBe("/x/app-worktree");
  });
});
