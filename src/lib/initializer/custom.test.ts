import { describe, expect, it } from "vitest";
import type { CustomTemplate } from "../types";
import { detokenize, tokenize } from "./custom";
import { buildPlan, customTemplate, defaultConfig, findTemplate, templateBody, validate } from "./index";

describe("custom templates", () => {
  it("tokenize and detokenize are inverse for the answers", () => {
    const t = { name: "Shop App", folder: "shop-app", identifier: "com.acme.shop", version: "1.2.0", description: "" };
    const v = { args: ["create", "shop-app", "--id", "com.acme.shop"], contents: "# Shop App", version: "1.2.0", other: "v1.2.0" };
    const tok = tokenize(v, t);
    expect(tok).toEqual({ args: ["create", "{{folder}}", "--id", "{{identifier}}"], contents: "# {{name}}", version: "{{version}}", other: "v1.2.0" });
    expect(detokenize(tok, t)).toEqual(v);
  });

  it("leaves short answers alone", () => {
    expect(tokenize({ s: "npm run ui" }, { name: "ui", folder: "ui" })).toEqual({ s: "npm run ui" });
  });

  it("a saved React plan rebuilds for a different project", () => {
    const react = findTemplate("react")!;
    const cfg = { ...defaultConfig(react, "/dev", "npm"), name: "Shop App", deps: { deps: "zod" } };
    const ct: CustomTemplate = {
      id: "x",
      name: "My React",
      blurb: "",
      kind: react.kind,
      icon: react.icon,
      baseId: "react",
      body: templateBody(react, cfg),
      createdAt: 0,
      updatedAt: 0,
    };
    expect(ct.body.steps.some((s) => s.kind === "git" || s.kind === "icons")).toBe(false);
    const mine = customTemplate(ct);
    expect(mine.group).toBe("My templates");
    const cfg2 = { ...defaultConfig(mine, "/dev"), name: "Blog" };
    expect(validate(mine, cfg2)).toBeNull();
    const plan = JSON.stringify(buildPlan(mine, cfg2));
    expect(plan).toContain('"blog"');
    expect(plan).not.toContain("shop-app");
    expect(plan).toContain("zod");
    expect(plan).toContain('"kind":"git"');
  });
});
