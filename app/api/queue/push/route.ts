import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { registerPushToken } from "@/server/push/push";
import { currentSession, fromThisSite, refused } from "@/server/web/http";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512;
const BODY_TIMEOUT_MS = 5000;

// The phone app hands its push token to the queue page, which sends it here from inside the shop's own session.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const read = await readCappedBody(request, MAX_BODY_BYTES, { timeoutMs: BODY_TIMEOUT_MS });
  if (!read.ok) return refused(400, "not a push token");
  try {
    const token = new URLSearchParams(new TextDecoder().decode(read.body)).get("token") ?? "";
    if (!(await registerPushToken(getDb(), session.shopId, token))) return refused(400, "not a push token");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("push token failed:", err instanceof Error ? err.name : "unknown error");
    return refused(503, "try again");
  }
}
