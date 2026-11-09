"use client";

import { useEffect, useState } from "react";
import { registerShopperTools, type AgentCall } from "./webmcp";

export function AgentCallPanel({ calls }: { calls: AgentCall[] }) {
  return (
    <section className="window shopper-result" aria-label="Agent tools" data-testid="agent-tools">
      <h2 className="section-title">Agent tools</h2>
      <p>This page offers tools to AI assistants (WebMCP). An assistant can search and check listings, but the buyer approves on PayPal.</p>
      <ol aria-live="polite">
        {calls.map((call) => <li key={call.id}><code>{call.name}</code> {call.input}: {call.result}</li>)}
      </ol>
    </section>
  );
}

export function AgentTools() {
  const [calls, setCalls] = useState<AgentCall[]>([]);
  useEffect(() => registerShopperTools(document as Document & Parameters<typeof registerShopperTools>[0], {
    fetch: (...args) => fetch(...args),
    open: () => window.open("about:blank", "_blank"),
    onCall: (call) => setCalls((previous) => [...previous.filter((p) => p.id !== call.id), call].sort((a, b) => a.id - b.id).slice(-20)),
  }), []);
  return <AgentCallPanel calls={calls} />;
}
