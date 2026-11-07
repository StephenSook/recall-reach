import { getDb } from "@/server/db/pg";
import { checkClaim, plantedClaims } from "@/server/safety/claimCheck";
import { fromThisSite, refused } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

const perVisitor = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

// No model runs and nothing is kept: this reads one public recall and answers.
export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor)) return Response.json({ error: "Too many tries from here. Try again in an hour." }, { status: 429 });
  const body = (await request.json().catch(() => null)) as { quote?: unknown } | null;
  try {
    const results = typeof body?.quote === "string" ? [await checkClaim(getDb(), body.quote)] : await plantedClaims(getDb());
    return Response.json({ results });
  } catch (err) {
    console.error("claim check failed:", err instanceof Error ? err.name : "unknown error");
    return Response.json({ error: "The check could not run just now." }, { status: 503 });
  }
}
