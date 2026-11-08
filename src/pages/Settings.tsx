import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Segmented } from "../components/ui";
import { SyncSection } from "../components/SyncSection";
import { openExternal } from "../lib/actions";
import { useStore } from "../lib/store";
import { ACCENTS } from "../lib/theme";
import { Section, Row } from "./settings/Shared";
import { AiSection } from "./settings/AiSection";
import { CliSection } from "./settings/CliSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { BackupSection } from "./settings/BackupSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { ConflictsSection } from "./settings/ConflictsSection";

export default function Settings() {
  const { settings, setSetting, editors, terminals, system } = useStore();
  const [params] = useSearchParams();
  const section = params.get("section");

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [section]);

  const theme = settings.theme ?? "system";
  const accent = settings.accent ?? "blue";

  return (
    <div className="h-full overflow-y-auto px-6 pb-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-[22px] font-bold tracking-tight">Settings</h1>

        <Section id="appearance" title="Appearance">
          <Row label="Theme" hint="System follows your operating system.">
            <Segmented value={theme as "system"} onChange={(v) => void setSetting("theme", v)} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          </Row>
          <Row label="Accent colour">
            <div className="flex gap-2">
              {Object.entries(ACCENTS).map(([k, a]) => (
                <button
                  key={k}
                  title={a.label}
                  aria-label={a.label}
                  onClick={() => void setSetting("accent", k)}
                  className="h-7 w-7 cursor-pointer rounded-full"
                  style={{ background: `linear-gradient(135deg, ${a.a}, ${a.b})`, outline: accent === k ? "2px solid var(--fg)" : "none", outlineOffset: 2 }}
                />
              ))}
            </div>
          </Row>
        </Section>

        <Section id="tools" title="Editors &amp; terminals">
          <Row label="Default editor" hint="Used by “Open in editor”. Each project can override it.">
            <select className="input !w-56" value={settings.defaultEditor ?? ""} onChange={(e) => void setSetting("defaultEditor", e.target.value)}>
              <option value="">First installed editor</option>
              {editors.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
              <option value="system">System default app</option>
            </select>
          </Row>
          <Row label="Default terminal">
            <select className="input !w-56" value={settings.defaultTerminal ?? "embedded"} onChange={(e) => void setSetting("defaultTerminal", e.target.value)}>
              <option value="embedded">Embedded terminal</option>
              <option value="system">System terminal</option>
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Row>
          <Row label="Run commands in" hint="Where the dashboard “Run” button starts commands.">
            <Segmented value={(settings.runIn ?? "embedded") as "embedded"} onChange={(v) => void setSetting("runIn", v)} options={[{ value: "embedded", label: "Embedded" }, { value: "system", label: "System terminal" }]} />
          </Row>
        </Section>

        <NotificationsSection />
        <AiSection />
        <SyncSection />
        <ConflictsSection />
        <BackupSection />
        <CliSection />
        <UpdatesSection />

        <Section id="about" title="About">
          <p className="text-[13px] text-[var(--fg-muted)]">
            BluePhoenix keeps your projects, to-dos and time in one place. Your data is stored locally and only leaves your computer when you enable cloud sync or use a cloud AI provider.
          </p>
          <div className="divider my-4" />
          <div className="flex flex-wrap items-center gap-5">
            <button className="cursor-pointer" onClick={() => openExternal("https://mintflow.dev")} aria-label="Visit mintflow.dev">
              <img src="/brand/mintflow-logo.webp" alt="MintFlow" className="h-10 w-auto" draggable={false} />
            </button>
            <div className="text-[13px]">
              <div className="font-semibold">Developed by MintFlow Technologies</div>
              <div className="text-[var(--fg-muted)]">Lead developer: Luca Montanari</div>
              <button className="mt-0.5 cursor-pointer text-[var(--accent)] hover:underline" onClick={() => openExternal("https://mintflow.dev")}>
                mintflow.dev
              </button>
            </div>
            <div className="ml-auto text-right text-xs text-[var(--fg-faint)]">
              BluePhoenix {system?.version}
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
