// SwiftUI apps generated with XcodeGen.
import type { Step, InitConfig, Template } from "../types";
import { pascal, parseDeps, sel, run } from "../helpers";

function swiftFiles(c: InitConfig, app: string): Step[] {
  const platform = sel(c, "platform");
  const ios = platform !== "macos";
  const mac = platform !== "ios";
  const hasIcon = !!c.icon;
  const f = (path: string, contents: string): Step => ({ kind: "write", label: `Write ${path}`, path, contents });

  const icon: Record<string, string>[] = [];
  if (ios) icon.push({ ...(hasIcon ? { filename: "icon-ios.png" } : {}), idiom: "universal", platform: "ios", size: "1024x1024" });
  if (mac) {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        icon.push({ ...(hasIcon ? { filename: `icon-mac-${size}@${scale}x.png` } : {}), idiom: "mac", scale: `${scale}x`, size: `${size}x${size}` });
      }
    }
  }
  const info = { author: "xcode", version: 1 };

  // "URL", "URL@version" or "URL@version#Product" (the product defaults to the repository name).
  const packages = parseDeps(c.deps.packages).map((spec) => {
    const [rest, product] = spec.split("#");
    const [url, from] = rest.split("@");
    const name = url.replace(/\.git$/, "").split("/").pop() ?? "package";
    return { name, url, from, product: product || name };
  });
  const pkgYaml = packages.length
    ? "packages:\n" + packages.map((p) => `  ${p.name}:\n    url: ${p.url}\n    ${p.from ? `from: ${p.from}` : "branch: main"}\n`).join("")
    : "";
  const depYaml = packages.length ? "    dependencies:\n" + packages.map((p) => `      - package: ${p.name}\n        product: ${p.product}\n`).join("") : "";

  const yml = `name: ${app}
options:
  bundleIdPrefix: ${c.identifier.split(".").slice(0, -1).join(".") || "com.example"}
  deploymentTarget:
${ios ? '    iOS: "17.0"\n' : ""}${mac ? '    macOS: "14.0"\n' : ""}  createIntermediateGroups: true
${pkgYaml}settings:
  base:
    SWIFT_VERSION: "5.0"
targets:
  ${app}:
    type: application
    platform: ${ios ? "iOS" : "macOS"}
${ios && mac ? "    supportedDestinations: [iOS, macOS]\n" : ""}    sources:
      - ${app}
${depYaml}    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${c.identifier}
        PRODUCT_NAME: ${c.name.trim().replace(/[:#]/g, "")}
        MARKETING_VERSION: "${c.version}"
        CURRENT_PROJECT_VERSION: "1"
        GENERATE_INFOPLIST_FILE: YES
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor
${ios ? "        INFOPLIST_KEY_UILaunchScreen_Generation: YES\n        INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES\n        TARGETED_DEVICE_FAMILY: \"1,2\"\n" : ""}${mac ? "        INFOPLIST_KEY_NSHumanReadableCopyright: \"\"\n" : ""}`;

  const swiftApp = `import SwiftUI

@main
struct ${app}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`;
  const content = `import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "sparkles")
                .imageScale(.large)
                .foregroundStyle(.tint)
            Text("Hello, ${c.name.trim().replace(/["\\]/g, "")}!")
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
`;
  return [
    f("project.yml", yml),
    f(`${app}/${app}App.swift`, swiftApp),
    f(`${app}/ContentView.swift`, content),
    f(`${app}/Assets.xcassets/Contents.json`, JSON.stringify({ info }, null, 2) + "\n"),
    f(`${app}/Assets.xcassets/AccentColor.colorset/Contents.json`, JSON.stringify({ colors: [{ idiom: "universal" }], info }, null, 2) + "\n"),
    f(`${app}/Assets.xcassets/AppIcon.appiconset/Contents.json`, JSON.stringify({ images: icon, info }, null, 2) + "\n"),
    f(".gitignore", ".DS_Store\nxcuserdata/\nDerivedData/\n.build/\n*.xcuserstate\n"),
  ];
}

export const swiftui: Template = {
  id: "swiftui",
  name: "SwiftUI",
  blurb: "Native Apple app for iOS and macOS (Xcode project via XcodeGen)",
  group: "Apple",
  icon: "Apple",
  kind: "Swift",
  options: [
    {
      id: "platform",
      label: "Platforms",
      type: "select",
      choices: [
        { value: "ios", label: "iOS" },
        { value: "macos", label: "macOS" },
        { value: "both", label: "iOS + macOS" },
      ],
      default: "ios",
    },
  ],
  identifier: { label: "Bundle identifier", placeholder: (c) => `com.example.${pascal(c.name).toLowerCase()}` },
  usesPm: false,
  depGroups: [{ id: "packages", label: "Swift packages (URL@version#Product)", placeholder: "https://github.com/apple/swift-collections@1.1.0#Collections" }],
  icons: ["apple"],
  tools: () => [{ program: "xcodegen", hint: "brew install xcodegen", required: true }],
  build(c) {
    const app = pascal(c.name);
    return [...swiftFiles(c, app), run("Generate the Xcode project", "xcodegen", ["generate"], "project")];
  },
  commands: (c) => {
    const app = pascal(c.name);
    const cmds = [{ label: "Open in Xcode", command: `open ${app}.xcodeproj` }];
    if (sel(c, "platform") !== "ios") cmds.push({ label: "Build (macOS)", command: `xcodebuild -scheme ${app} -destination 'platform=macOS' build` });
    return cmds;
  },
};
