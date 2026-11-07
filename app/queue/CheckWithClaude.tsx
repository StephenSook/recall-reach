"use client";

import { useEffect, useState } from "react";

/** A new answer took 39 s when measured on the deployed site, so the button says what's happening. A plain post still works without script. */
export function CheckWithClaude({ recordId, here }: { recordId: string; here: string }) {
  const [reading, setReading] = useState(false);
  useEffect(() => {
    const reset = () => setReading(false); // coming back with the browser's back button
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <form action={`/api/queue/agent${here}`} method="post" onSubmit={() => setReading(true)}>
      <input type="hidden" name="recordId" value={recordId} />
      <button type="submit" className="btn btn-outline" disabled={reading}>
        {reading ? "Claude is reading" : "Check with Claude"}
      </button>
      {reading ? (
        <p role="status" data-testid="claude-reading">
          <small>A new answer can take up to a minute. One already stored comes straight back.</small>
        </p>
      ) : null}
    </form>
  );
}
