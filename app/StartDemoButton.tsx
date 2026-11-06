"use client";

import { useEffect, useState } from "react";

/** A double click must not make a second demo shop: each one spends real sandbox captures. */
export function StartDemoButton() {
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    const reset = () => setStarting(false); // coming back with the browser's back button
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <form action="/api/demo/start" method="post" onSubmit={() => setStarting(true)}>
      <button type="submit" className="btn big" disabled={starting}>
        {starting ? "Setting up your shop" : "Try it as a demo shop"}
      </button>
    </form>
  );
}
