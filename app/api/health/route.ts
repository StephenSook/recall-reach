import { getDb } from "@/server/db/pg";
import { getHealth } from "@/server/health";
import { recallPollStatus } from "@/server/jobs/appJobs";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let health;
  try {
    health = await getHealth(getDb(), { PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID, RECORD_HMAC_SECRET: process.env.RECORD_HMAC_SECRET, DEBUG: process.env.DEBUG, NODE_DEBUG: process.env.NODE_DEBUG }, recallPollStatus());
  } catch (err) {
    // getDb() throws when DATABASE_URL is missing or malformed.
    console.error("health check failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false, database: { ok: false } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  // CPSC failing isn't this site failing: the body says so, and 503 stays for what's ours.
  return Response.json(health, { status: health.ok || health.degraded ? 200 : 503, headers: { "cache-control": "no-store" } });
}
