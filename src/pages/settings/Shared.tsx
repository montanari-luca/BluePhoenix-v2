import { type ReactNode } from "react";

export function Section({ id, title, desc, children }: { id: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <section id={id} className="glass p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {desc && <p className="mt-0.5 mb-4 text-[13px] text-[var(--fg-muted)]">{desc}</p>}
      {!desc && <div className="h-3" />}
      {children}
    </section>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div>
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="text-xs text-[var(--fg-faint)]">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
