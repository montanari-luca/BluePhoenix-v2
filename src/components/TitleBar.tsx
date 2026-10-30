import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUpCircle, LayoutGrid, Minus, Zap, Search, Settings as SettingsIcon, Square, X } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useStore } from "../lib/store";
import { Kbd } from "./ui";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="bp-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8cff" />
          <stop offset="0.6" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#f97316" />
        </linearGradient>
      </defs>
      <path
        d="M32 4c2 9 11 13 14 22 2 6 0 11-3 15 6-2 10-8 10-15 7 7 9 18 3 27-5 8-15 11-24 11S13 61 8 53c-6-9-4-20 3-27 0 7 4 13 10 15-3-4-5-9-3-15 3-9 12-13 14-22z"
        fill="url(#bp-g)"
      />
      <path d="M32 26c4 6 8 9 8 15a8 8 0 0 1-16 0c0-6 4-9 8-15z" fill="#fff" fillOpacity="0.92" />
    </svg>
  );
}

export function TitleBar() {
  const platform = useStore((s) => s.system?.platform);
  const update = useStore((s) => s.update);
  const setPalette = useStore((s) => s.setPalette);
  const isMac = platform === "macos";
  const win = getCurrentWindow();

  return (
    <div
      data-tauri-drag-region
      className="relative z-20 flex h-[52px] shrink-0 items-center gap-2 pr-2"
      style={{ paddingLeft: isMac ? 86 : 14 }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) void win.toggleMaximize();
      }}
    >
      <div className="pointer-events-none flex items-center gap-2 pr-2">
        <Logo />
        <span className="text-[14px] font-semibold tracking-tight">BluePhoenix</span>
      </div>

      <NavLink to="/" end className="no-drag">
        {({ isActive }) => (
          <span className="tab no-drag" data-active={isActive}>
            <LayoutGrid size={15} /> Dashboard
          </span>
        )}
      </NavLink>
      <NavLink to="/automations" className="no-drag">
        {({ isActive }) => (
          <span className="tab no-drag" data-active={isActive}>
            <Zap size={15} /> Automations
          </span>
        )}
      </NavLink>
      <NavLink to="/settings" className="no-drag">
        {({ isActive }) => (
          <span className="tab no-drag" data-active={isActive}>
            <SettingsIcon size={15} /> Settings
          </span>
        )}
      </NavLink>

      <div data-tauri-drag-region className="h-full flex-1" />

      {update && (
        <NavLink
          to="/settings?section=updates"
          className="btn btn-sm no-drag"
          style={{ color: "var(--ok)" }}
          title={`Version ${update.latest} is available`}
        >
          <ArrowUpCircle size={14} /> Update {update.latest}
        </NavLink>
      )}

      <button className="btn no-drag min-w-[200px] justify-between text-[var(--fg-muted)]" onClick={() => setPalette(true)}>
        <span className="flex items-center gap-2">
          <Search size={14} /> Search or run an action…
        </span>
        <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd>
      </button>

      {platform && !isMac && (
        <div className="no-drag ml-1 flex items-center">
          <button className="btn btn-ghost btn-icon" onClick={() => void win.minimize()} aria-label="Minimize">
            <Minus size={15} />
          </button>
          <button className="btn btn-ghost btn-icon" onClick={() => void win.toggleMaximize()} aria-label="Maximize">
            <Square size={12} />
          </button>
          <button
            className="btn btn-ghost btn-icon hover:!bg-[var(--bad)] hover:!text-white"
            onClick={() => void win.close()}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
