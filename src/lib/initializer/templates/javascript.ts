// JavaScript web and mobile apps: Vite, Next.js, Astro, SvelteKit, Expo.
import type { Step, Template } from "../types";
import { slugify, parseDeps, sel, on, dlx, exec, install, add, nodeDeps, packageJson, nodeTools, LANG_TS_JS, NODE_DEPS } from "../helpers";

function viteTemplate(id: string, name: string, kind: string, icon: string, blurb: string, base: string, extra?: Partial<Template>): Template {
  return {
    id,
    name,
    blurb,
    group: "Web",
    icon,
    kind,
    languages: LANG_TS_JS,
    options: [],
    usesPm: true,
    depGroups: NODE_DEPS,
    icons: ["web"],
    tools: nodeTools,
    build(c) {
      const compiler = on(c, "compiler");
      const template = `${base}${compiler ? "-compiler" : ""}${c.language === "ts" ? "-ts" : ""}`;
      const steps: Step[] = [
        dlx(c.pm, "create-vite@latest", [c.folder, "--template", template, "--no-interactive"], `Create the ${name} app (Vite)`),
        packageJson(c),
      ];
      if (c.icon) {
        steps.push({
          kind: "replace",
          label: "Point index.html at the new favicon",
          file: "index.html",
          pattern: String.raw`<link rel="icon"[^>]*href="/(?:vite|favicon)\.svg"[^>]*/?>`,
          replacement: `<link rel="icon" href="/favicon.ico" sizes="any" />\n    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
          optional: true,
        });
      }
      steps.push(...nodeDeps(c));
      return steps;
    },
    commands: (c) => [{ label: "Dev server", command: `${c.pm} run dev` }],
    ...extra,
  };
}

export const react = viteTemplate("react", "React", "React", "Atom", "Single-page app with Vite", "react", {
  options: [{ id: "compiler", label: "Enable React Compiler", type: "toggle", default: false }],
});
export const vue = viteTemplate("vue", "Vue", "Vue", "Layers", "Single-page app with Vite", "vue");

export const nextjs: Template = {
  id: "nextjs",
  name: "Next.js",
  blurb: "Full-stack React framework",
  group: "Web",
  icon: "Triangle",
  kind: "Next.js",
  languages: LANG_TS_JS,
  options: [
    {
      id: "router",
      label: "Router",
      type: "select",
      choices: [
        { value: "app", label: "App Router" },
        { value: "pages", label: "Pages Router" },
      ],
      default: "app",
    },
    { id: "tailwind", label: "Tailwind CSS", type: "toggle", default: true },
    { id: "eslint", label: "ESLint", type: "toggle", default: true },
    { id: "src", label: "Use a src/ directory", type: "toggle", default: false },
  ],
  usesPm: true,
  depGroups: NODE_DEPS,
  icons: ["web"],
  tools: nodeTools,
  build(c) {
    const args = [
      c.folder,
      c.language === "ts" ? "--ts" : "--js",
      on(c, "tailwind") ? "--tailwind" : "--no-tailwind",
      on(c, "eslint") ? "--eslint" : "--no-eslint",
      sel(c, "router") === "pages" ? "--no-app" : "--app",
      on(c, "src") ? "--src-dir" : "--no-src-dir",
      "--import-alias",
      "@/*",
      `--use-${c.pm}`,
      "--skip-install",
      "--disable-git",
      "--yes",
    ];
    return [dlx(c.pm, "create-next-app@latest", args, "Create the Next.js app"), packageJson(c), ...nodeDeps(c)];
  },
  commands: (c) => [{ label: "Dev server", command: `${c.pm} run dev` }],
};

export const astro: Template = {
  id: "astro",
  name: "Astro",
  blurb: "Content-focused websites with islands of UI",
  group: "Web",
  icon: "Rocket",
  kind: "Astro",
  frameworkLabel: "UI framework",
  frameworks: [
    { value: "none", label: "None" },
    { value: "react", label: "React" },
    { value: "vue", label: "Vue" },
    { value: "svelte", label: "Svelte" },
    { value: "solid-js", label: "Solid" },
    { value: "preact", label: "Preact" },
  ],
  options: [
    {
      id: "starter",
      label: "Starter",
      type: "select",
      choices: [
        { value: "basics", label: "Basics" },
        { value: "minimal", label: "Minimal" },
        { value: "blog", label: "Blog" },
      ],
      default: "basics",
    },
    { id: "tailwind", label: "Tailwind CSS", type: "toggle", default: false },
  ],
  usesPm: true,
  depGroups: NODE_DEPS,
  icons: ["web"],
  tools: nodeTools,
  build(c) {
    const steps: Step[] = [
      dlx(c.pm, "create-astro@latest", [c.folder, "--template", sel(c, "starter"), "--no-install", "--no-git", "--yes", "--skip-houston"], "Create the Astro site"),
      packageJson(c),
      install(c.pm),
    ];
    const integrations = [c.framework !== "none" ? c.framework : "", on(c, "tailwind") ? "tailwind" : ""].filter(Boolean);
    if (integrations.length) steps.push(exec(c.pm, ["astro", "add", ...integrations, "--yes"], `Add ${integrations.join(" + ")}`));
    const deps = parseDeps(c.deps.deps);
    const dev = parseDeps(c.deps.dev);
    if (deps.length) steps.push(add(c.pm, deps, false, `Add ${deps.join(", ")}`));
    if (dev.length) steps.push(add(c.pm, dev, true, `Add ${dev.join(", ")} (dev)`));
    return steps;
  },
  commands: (c) => [{ label: "Dev server", command: `${c.pm} run dev` }],
};

export const sveltekit: Template = {
  id: "sveltekit",
  name: "SvelteKit",
  blurb: "Full-stack Svelte framework",
  group: "Web",
  icon: "Flame",
  kind: "SvelteKit",
  languages: [
    { value: "ts", label: "TypeScript" },
    { value: "js", label: "JavaScript (JSDoc)" },
  ],
  options: [
    { id: "tailwind", label: "Tailwind CSS", type: "toggle", default: false },
    { id: "eslint", label: "ESLint", type: "toggle", default: true },
    { id: "prettier", label: "Prettier", type: "toggle", default: true },
    { id: "vitest", label: "Vitest", type: "toggle", default: false },
  ],
  usesPm: true,
  depGroups: NODE_DEPS,
  icons: ["web"],
  tools: nodeTools,
  build(c) {
    // Add-ons that ask follow-up questions need their answers on the command line.
    const addons = [on(c, "tailwind") && "tailwindcss=plugins:none", on(c, "eslint") && "eslint", on(c, "prettier") && "prettier", on(c, "vitest") && "vitest=usages:unit,component"].filter(Boolean) as string[];
    const args = [
      "create",
      c.folder,
      "--template",
      "minimal",
      "--types",
      c.language === "ts" ? "ts" : "jsdoc",
      ...(addons.length ? ["--add", ...addons] : ["--no-add-ons"]),
      "--no-install",
    ];
    return [dlx(c.pm, "sv@latest", args, "Create the SvelteKit app"), packageJson(c), ...nodeDeps(c)];
  },
  commands: (c) => [{ label: "Dev server", command: `${c.pm} run dev` }],
};

export const expo: Template = {
  id: "expo",
  name: "Expo (React Native)",
  blurb: "iOS and Android apps with React Native",
  group: "Desktop & mobile",
  icon: "Smartphone",
  kind: "Expo",
  options: [
    {
      id: "starter",
      label: "Starter",
      type: "select",
      choices: [
        { value: "default", label: "Default (Expo Router, TypeScript)" },
        { value: "tabs", label: "Tabs (Expo Router)" },
        { value: "blank-typescript", label: "Blank (TypeScript)" },
        { value: "blank", label: "Blank (JavaScript)" },
      ],
      default: "default",
    },
  ],
  identifier: { label: "Bundle identifier / package", placeholder: (c) => `com.example.${slugify(c.name).replace(/[^a-z0-9]/g, "") || "app"}` },
  usesPm: true,
  depGroups: [
    { id: "deps", label: "Extra dependencies", placeholder: "zustand" },
    { id: "dev", label: "Extra dev dependencies", placeholder: "prettier" },
  ],
  icons: ["expo"],
  tools: nodeTools,
  build(c) {
    return [
      dlx(c.pm, "create-expo-app@latest", [c.folder, "--template", sel(c, "starter"), "--no-install", "--yes"], "Create the Expo app"),
      {
        kind: "jsonSet",
        label: "Set name, version and identifiers in app.json",
        file: "app.json",
        sets: [
          { path: "expo.name", value: c.name.trim() },
          { path: "expo.version", value: c.version },
          { path: "expo.ios.bundleIdentifier", value: c.identifier },
          { path: "expo.android.package", value: c.identifier },
        ],
      },
      packageJson(c),
      ...nodeDeps(c),
    ];
  },
  commands: (c) => [{ label: "Start Expo", command: `${c.pm === "npm" ? "npx" : c.pm === "bun" ? "bunx" : c.pm} expo start` }],
};
