import { getDb } from "@/server/db/pg";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { runReplay } from "@/server/replay/replay";
import { businessDay } from "@/server/time/businessDay";
import { fromThisSite, refused, secret, seeOther } from "@/server/web/http";
import { createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

// It makes no sale and calls no model, so a limit for everyone together is enough to keep it from filling the database.
const everyone = createRateLimiter({ limit: 12, windowMs: 60 * 60_000 });

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  if (!everyone("all")) return seeOther(request, "/replay?error=busy");
  try {
    const { runId } = await runReplay(getDb(), payPalClientFromEnv(), { today: businessDay(), now: new Date(), secret: secret("SHOP_DATA_KEY") });
    return seeOther(request, `/replay/${runId}`);
  } catch (err) {
    console.error("replay failed:", err instanceof Error ? err.message : "unknown error");
    return seeOther(request, "/replay?error=failed");
  }
}
