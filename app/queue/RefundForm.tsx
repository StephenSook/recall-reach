"use client";

import { useEffect, useState } from "react";

/** PayPal can take several seconds to answer, so the button says it's asking. A second press would only be refused. */
export function RefundForm({ approvalId, label }: { approvalId: string; label: string }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const reset = () => setAsking(false); // coming back with the browser's back button
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <form action="/api/queue/refunds/execute" method="post" onSubmit={() => setAsking(true)}>
      <input type="hidden" name="approvalId" value={approvalId} />
      <button type="submit" className="btn" disabled={asking}>
        {asking ? "Asking PayPal" : label}
      </button>
    </form>
  );
}
