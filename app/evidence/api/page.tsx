import Link from "next/link";
import { getDb } from "@/server/db/pg";
import { publicCallTotals } from "@/server/web/publicCalls";
import { ClaimList } from "../ClaimList";
import { API_CLAIMS } from "../claims";

export const dynamic = "force-dynamic";

const SITE = "https://recall-reach-web-e022.onrender.com";

const MCP_CONFIG = JSON.stringify({ mcpServers: { "recall-reach": { type: "http", url: `${SITE}/api/mcp` } } }, null, 2);

async function totals() {
  try {
    return await publicCallTotals(getDb());
  } catch {
    return null; // the page still says how to use it
  }
}

export default async function ApiEvidence() {
  const calls = await totals();
  return (
    <main className="page">
      <header className="page-head">
        <h1>For agents and marketplaces</h1>
      </header>
      <p>Check a product against real CPSC recalls before it is listed or bought. No key.</p>
      <h2 className="section-title">From a terminal</h2>
      <pre data-testid="api-curl">{`curl "${SITE}/api/check?title=Baby%20Brezza%20sterilizer&model=BRZ0083"`}</pre>
      <h2 className="section-title">As a tool for an agent</h2>
      <pre data-testid="mcp-config">{MCP_CONFIG}</pre>
      <p>
        Two read-only tools: <code>check_recall</code>, and <code>get_recall</code>, which gives one recall&apos;s CPSC text by its number. A result names a recall to read, not a finding about the item, and an empty result doesn&apos;t mean an item is safe. <a href="/openapi.yaml">The OpenAPI file</a>.
      </p>
      <ClaimList claims={API_CLAIMS} />
      {calls ? (
        <p className="note" data-testid="public-calls">
          {calls.api} checks through the API and {calls.mcp} through the tool{calls.since ? ` since ${calls.since}` : ""}, our own tests included. Only the counts are kept.
        </p>
      ) : null}
      <p className="note">
        Nothing you send is stored or logged, and it never goes to PayPal or Claude. <Link href="/judge">Back</Link>
      </p>
      <div className="provenance">
        <span className="chip chip-real">Real CPSC</span>
      </div>
    </main>
  );
}
