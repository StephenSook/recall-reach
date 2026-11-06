import { getDb } from "@/server/db/pg";
import { runSafetyChecks } from "@/server/safety/attacks";
import { fromThisSite, refused, secret, seeOther } from "@/server/web/http";
import { createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

// It moves no money and calls no model, so a limit for everyone together is enough to keep it from filling the database.
const everyone = createRateLimiter({ limit: 12, windowMs: 60 * 60_000 });

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  if (!everyone("all")) return seeOther(request, "/safety?error=busy");
  try {
    await runSafetyChecks(getDb(), { now: new Date(), secret: secret("SHOP_DATA_KEY") });
    return seeOther(request, "/safety");
  } catch (err) {
    console.error("safety checks failed:", err instanceof Error ? err.message : "unknown error");
    return seeOther(request, "/safety?error=failed");
  }
}
