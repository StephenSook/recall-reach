import { agentConfigured } from "@/server/agent/questionStore";
import { getDb } from "@/server/db/pg";
import { getHealth, type Health } from "@/server/health";
import { recallPollStatus } from "@/server/jobs/appJobs";
import { ranAt } from "@/app/replay/labels";
import { statusLines, type LineState } from "./lines";

export const dynamic = "force-dynamic";

const STATE: Record<LineState, string> = { ok: "OK", problem: "Problem", unknown: "Can't tell" };

async function readHealth(): Promise<Health | null> {
  try {
    return await getHealth(getDb(), { PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID, RECORD_HMAC_SECRET: process.env.RECORD_HMAC_SECRET, DEBUG: process.env.DEBUG, NODE_DEBUG: process.env.NODE_DEBUG, RENDER_GIT_COMMIT: process.env.RENDER_GIT_COMMIT }, recallPollStatus());
  } catch (err) {
    // getDb() throws when DATABASE_URL is missing or malformed.
    console.error("status page failed:", err instanceof Error ? err.name : "unknown error");
    return null;
  }
}

export default async function StatusPage() {
  const health = await readHealth();
  return (
    <main className="page">
      <header className="page-head">
        <h1>Status</h1>
      </header>
      <p>What each outside service last showed, and what that reading does and doesn&apos;t tell you.</p>
      {health ? (
        <>
          <ul className="window cleared-list" data-testid="status-lines">
            {statusLines(health, { claudeKeySet: agentConfigured() }).map((line) => (
              <li key={line.service} data-state={line.state}>
                <strong>{line.service}</strong>: {STATE[line.state]}. {line.reading}
                <span className="quiet">{line.measures}</span>
              </li>
            ))}
          </ul>
          <p className="note" data-testid="status-build">
            Read {ranAt(health.checkedAt)}{health.build ? `, from build ${health.build}` : ""}. The same data is at /api/health.
          </p>
        </>
      ) : (
        <p role="alert" className="alert">
          The status could not be read just now.
        </p>
      )}
    </main>
  );
}
