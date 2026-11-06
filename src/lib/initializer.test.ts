import { describe, expect, it } from "vitest";
import { TEMPLATES, buildPlan, defaultConfig, findTemplate, parseDeps, pascal, requiredTools, resolved, slugify, validate, type InitConfig } from "./initializer";

function cfg(id: string, patch: Partial<InitConfig> = {}): [NonNullable<ReturnType<typeof findTemplate>>, InitConfig] {
  const t = findTemplate(id)!;
  return [t, { ...defaultConfig(t, "/work", "pnpm"), name: "My App", ...patch }];
}

const run = (steps: ReturnType<typeof buildPlan>) => steps.filter((s) => s.kind === "run") as Extract<ReturnType<typeof buildPlan>[number], { kind: "run" }>[];

describe("naming helpers", () => {
  it("slugifies and pascal-cases names", () => {
    expect(slugify("  My Cool App! ")).toBe("my-cool-app");
    expect(pascal("my cool-app")).toBe("MyCoolApp");
    expect(pascal("3d")).toBe("App3d");
  });
  it("splits dependency lists", () => {
    expect(parseDeps("a, b\n c  d")).toEqual(["a", "b", "c", "d"]);
    expect(parseDeps(undefined)).toEqual([]);
  });
});

describe("tauri", () => {
  it("scaffolds a v2 react-ts app with the chosen manager and identifier", () => {
    const [t, c] = cfg("tauri", { framework: "react", identifier: "com.me.app", version: "2.0.0", deps: { deps: "zustand", crates: "anyhow" } });
    const steps = buildPlan(t, { ...c, icon: "/i.png" });
    const create = run(steps)[0];
    expect(create.program).toBe("pnpm");
    expect(create.args).toEqual(["dlx", "create-tauri-app@latest", "my-app", "-m", "pnpm", "-t", "react-ts", "--identifier", "com.me.app", "--tauri-version", "2", "-y"]);
    expect(create.expects).toBe("src-tauri/tauri.conf.json");
    expect(steps.find((s) => s.kind === "jsonSet" && s.file.endsWith("tauri.conf.json"))).toMatchObject({ sets: [{ path: "version", value: "2.0.0" }, { path: "productName", value: "My App" }] });
    expect(run(steps).some((s) => s.program === "cargo" && s.cwd === "project/src-tauri" && s.args.join(" ") === "add anyhow")).toBe(true);
    expect(steps.find((s) => s.kind === "icons")).toMatchObject({ targets: ["tauri"] });
    expect(steps.at(-1)).toMatchObject({ kind: "git", commit: true });
  });
  it("uses the js variant, and cargo as manager for Rust frontends", () => {
    const [t, c] = cfg("tauri", { framework: "vue", language: "js" });
    expect(run(buildPlan(t, c))[0].args).toContain("vue");
    const [t2, c2] = cfg("tauri", { framework: "leptos" });
    const steps = run(buildPlan(t2, c2));
    expect(steps[0].args).toContain("leptos");
    expect(steps.some((s) => s.args[0] === "install")).toBe(false);
  });
});

describe("web templates", () => {
  it("adapts commands to the package manager", () => {
    const [t, c] = cfg("react", { pm: "npm", deps: { deps: "zustand", dev: "vitest" } });
    const steps = run(buildPlan(t, c));
    expect(steps[0]).toMatchObject({ program: "npx", args: ["--yes", "create-vite@latest", "my-app", "--template", "react-ts", "--no-interactive"] });
    expect(steps.map((s) => s.args.join(" "))).toContain("install -D vitest");
    const [t2, c2] = cfg("react", { pm: "bun", deps: { dev: "vitest" } });
    expect(run(buildPlan(t2, c2)).map((s) => `${s.program} ${s.args.join(" ")}`)).toContain("bun add -d vitest");
  });
  it("passes next.js options as flags", () => {
    const [t, c] = cfg("nextjs", { language: "js", options: { router: "pages", tailwind: false, eslint: true, src: true } });
    const args = run(buildPlan(t, c))[0].args;
    expect(args).toEqual(expect.arrayContaining(["--js", "--no-tailwind", "--eslint", "--no-app", "--src-dir", "--use-pnpm", "--skip-install", "--disable-git"]));
  });
  it("adds astro integrations after install", () => {
    const [t, c] = cfg("astro", { framework: "react", options: { starter: "blog", tailwind: true } });
    const steps = run(buildPlan(t, c));
    expect(steps[0].args).toContain("blog");
    const addStep = steps.find((s) => s.args.includes("add"))!;
    expect(addStep.args).toEqual(["exec", "astro", "add", "react", "tailwind", "--yes"]);
  });
  it("gives sveltekit add-ons their answers up front", () => {
    const [t, c] = cfg("sveltekit", { options: { tailwind: true, eslint: false, prettier: true, vitest: false } });
    const args = run(buildPlan(t, c))[0].args;
    expect(args.slice(args.indexOf("--add"))).toEqual(["--add", "tailwindcss=plugins:none", "prettier", "--no-install"]);
  });
});

describe("swiftui", () => {
  it("writes an XcodeGen project and runs xcodegen", () => {
    const [t, c] = cfg("swiftui", { identifier: "com.me.myapp", options: { platform: "both" }, deps: { packages: "https://github.com/apple/swift-collections@1.1.0#Collections" }, icon: "/i.png" });
    const steps = buildPlan(t, c);
    const yml = steps.find((s) => s.kind === "write" && s.path === "project.yml");
    expect(yml).toBeTruthy();
    const text = (yml as { contents: string }).contents;
    expect(text).toContain("supportedDestinations: [iOS, macOS]");
    expect(text).toContain("PRODUCT_BUNDLE_IDENTIFIER: com.me.myapp");
    expect(text).toContain("from: 1.1.0");
    expect(text).toContain("- package: swift-collections\n        product: Collections");
    const icons = steps.find((s) => s.kind === "write" && s.path.endsWith("AppIcon.appiconset/Contents.json")) as { contents: string };
    expect(JSON.parse(icons.contents).images.every((i: { filename?: string }) => i.filename)).toBe(true);
    expect(run(steps)[0]).toMatchObject({ program: "xcodegen", args: ["generate"], cwd: "project" });
    expect(steps.find((s) => s.kind === "icons")).toMatchObject({ targets: ["apple"] });
  });
  it("leaves icon filenames out when no icon is picked", () => {
    const [t, c] = cfg("swiftui", { identifier: "com.me.myapp" });
    const icons = buildPlan(t, c).find((s) => s.kind === "write" && s.path.endsWith("AppIcon.appiconset/Contents.json")) as { contents: string };
    expect(JSON.parse(icons.contents).images.some((i: { filename?: string }) => i.filename)).toBe(false);
  });
});

describe("languages", () => {
  it("builds a rust crate", () => {
    const [t, c] = cfg("rust", { options: { crate: "lib" }, deps: { deps: "serde" } });
    const steps = run(buildPlan(t, c));
    expect(steps[0].args).toEqual(["new", "my-app", "--lib", "--vcs", "none"]);
    expect(steps[1].args).toEqual(["add", "serde"]);
  });
  it("builds a python project with uv", () => {
    const [t, c] = cfg("python", { options: { layout: "package", python: "3.12" }, deps: { deps: "requests", dev: "pytest" } });
    const steps = run(buildPlan(t, c));
    expect(steps[0].args).toEqual(["init", "my-app", "--package", "--vcs", "none", "--python", "3.12"]);
    expect(steps.map((s) => s.args.join(" "))).toEqual(expect.arrayContaining(["add requests", "add --dev pytest"]));
  });
});

describe("validation and tools", () => {
  it("rejects bad input", () => {
    const [t, c] = cfg("react");
    expect(validate(t, { ...c, name: "" })).toMatch(/name/i);
    expect(validate(t, { ...c, version: "1.0" })).toMatch(/version/i);
    expect(validate(t, { ...c, folder: "Bad Folder" })).toMatch(/folder/i);
    expect(validate(t, c)).toBeNull();
    const [tt, tc] = cfg("tauri", { identifier: "nope" });
    expect(validate(tt, tc)).toMatch(/identifier/i);
    expect(validate(tt, { ...tc, identifier: "" })).toBeNull();
  });
  it("derives defaults", () => {
    const [t, c] = cfg("tauri");
    expect(resolved(t, c)).toMatchObject({ folder: "my-app", identifier: "com.example.myapp", version: "0.1.0" });
  });
  it("lists the tools a setup needs", () => {
    const [t, c] = cfg("react", { github: "private" });
    expect(requiredTools(t, c).map((x) => x.program)).toEqual(["pnpm", "git", "gh"]);
    expect(requiredTools(t, { ...c, git: false, github: "" }).map((x) => x.program)).toEqual(["pnpm"]);
  });
  it("every template produces a plan", () => {
    for (const t of TEMPLATES) {
      const c: InitConfig = { ...defaultConfig(t, "/work", "npm"), name: "Demo App", icon: "/i.png" };
      expect(buildPlan(t, c).length).toBeGreaterThan(1);
      expect(validate(t, c)).toBeNull();
    }
  });
});
