"use client";

import { useEffect, useState } from "react";

/** A run takes a while on a sleeping server, and a second press would only start another. */
export function RunAgainButton({ label = "Run it again" }: { label?: string }) {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const reset = () => setRunning(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <form action="/api/replay/run" method="post" onSubmit={() => setRunning(true)}>
      <button type="submit" className="btn btn-outline" disabled={running}>
        {running ? "Running" : label}
      </button>
    </form>
  );
}
