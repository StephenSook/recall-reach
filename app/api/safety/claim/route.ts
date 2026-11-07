import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { checkClaim, plantedClaims } from "@/server/safety/claimCheck";
import { fromThisSite, refused } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

const MAX_BODY = 2 * 1024;
const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const perVisitor = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

// No model runs and nothing is kept: this reads one public recall and answers.
export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor)) return Response.json({ error: "Too many tries from here. Try again in an hour." }, { status: 429 });
  const read = await readCappedBody(request, MAX_BODY);
  if (!read.ok) return Response.json({ error: "request too large" }, { status: 413 });
  const body = parseJson(read.body) as { quote?: unknown } | null;
  try {
    const results = typeof body?.quote === "string" ? [await checkClaim(getDb(), body.quote)] : await plantedClaims(getDb());
    return Response.json({ results });
  } catch (err) {
    console.error("claim check failed:", err instanceof Error ? err.name : "unknown error");
    return Response.json({ error: "The check could not run just now." }, { status: 503 });
  }
}
