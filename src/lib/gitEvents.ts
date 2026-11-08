import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

/** Calls `onChange` whenever the backend's .git watcher reports a change in this project. */
export function useGitChanged(projectId: string, onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const un = listen<string[]>("git-changed", (e) => {
      if (e.payload.includes(projectId)) cb.current();
    });
    return () => void un.then((f) => f());
  }, [projectId]);
}
