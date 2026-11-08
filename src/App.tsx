import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { HashRouter, Route, Routes, useNavigate } from "react-router-dom";
import { CommandPalette } from "./components/CommandPalette";
import { TitleBar } from "./components/TitleBar";
import { Toasts } from "./components/ui";
import { api } from "./lib/api";
import type { AutomationSummary, ForkSync } from "./lib/types";
import { setNavigator } from "./lib/actions";
import { useStore, logError } from "./lib/store";
import Automations from "./pages/Automations";
import Dashboard from "./pages/Dashboard";
import ProjectPage from "./pages/ProjectPage";
import Settings from "./pages/Settings";

function Shell() {
  const navigate = useNavigate();
  const init = useStore((s) => s.init);
  const setUpdate = useStore((s) => s.setUpdate);

  useEffect(() => {
    setNavigator(navigate);
  }, [navigate]);

  useEffect(() => {
    const un = listen<{ provider: string; state: string; message: string }>("local-ai", (e) => {
      const { state, message } = e.payload;
      if (state === "started") useStore.getState().toast({ kind: "success", title: message, detail: "Local AI is ready." });
      if (state === "failed") useStore.getState().toast({ kind: "error", title: "Local AI is not available", detail: message });
    });
    return () => void un.then((f) => f());
  }, []);

  // Automations run in the background (launch, schedule, commit, quit); refresh the list and surface failures.
  useEffect(() => {
    const un = listen<AutomationSummary[]>("automation-finished", (e) => {
      const { toast, loadAutomations } = useStore.getState();
      void loadAutomations();
      for (const s of e.payload) {
        if (s.failed > 0) toast({ kind: "error", title: `${s.name}: ${s.failed} failed`, detail: "Open Automations for the run log." });
      }
    });
    return () => void un.then((f) => f());
  }, []);

  // Fork upstream checks run in the background; keep the badges and the Git tab current.
  useEffect(() => {
    const un = listen<ForkSync[]>("fork-sync-finished", (e) => {
      const { setForks, refreshStatus } = useStore.getState();
      setForks(e.payload);
      for (const f of e.payload) if (f.status === "pulled") void refreshStatus(f.projectId);
    });
    return () => void un.then((f) => f());
  }, []);

  // `bluephoenix add` writes to the same database from a terminal; pick that up when the window regains focus.
  useEffect(() => {
    const onFocus = () => void useStore.getState().loadProjects();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    void init().then(() => {
      if ((useStore.getState().settings.autoUpdate ?? "true") !== "true") return;
      api
        .checkUpdate()
        .then((r) => r.available && setUpdate({ latest: r.latest, downloadUrl: r.downloadUrl }))
        .catch(logError("update check"));
    });
  }, [init, setUpdate]);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/project/:id" element={<ProjectPage />} />
          <Route path="/automations" element={<Automations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </main>
      <CommandPalette />
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
