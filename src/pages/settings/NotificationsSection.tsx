import { Toggle } from "../../components/ui";
import { useStore } from "../../lib/store";
import { Row, Section } from "./Shared";

const KINDS = [
  { key: "notify.automationFailed", label: "An automation failed", hint: "Even for automations set to run quietly." },
  { key: "notify.fork", label: "A fork has upstream changes", hint: "New commits to pull, a pull that happened, or a conflict." },
  { key: "notify.todoDue", label: "To-dos are due today", hint: "Once a day, from 9:00, with overdue ones too." },
];

/** System notifications, one switch per kind (all on until turned off). */
export function NotificationsSection() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <Section id="notifications" title="Notifications" desc="BluePhoenix uses your system's notifications while it is open.">
      {KINDS.map((k) => (
        <Row key={k.key} label={k.label} hint={k.hint}>
          <Toggle label={k.label} checked={settings[k.key] !== "false"} onChange={(on) => void setSetting(k.key, on ? "true" : "false")} />
        </Row>
      ))}
    </Section>
  );
}
