import { getDb } from "@/server/db/pg";
import { buyAsFamily, LiveSaleRefused } from "@/server/demo/liveCatch";
import { withCallLog } from "@/server/paypal/callLog";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { businessDay } from "@/server/time/businessDay";
import { currentSession, fromThisSite, refused, secret, seeOther, withMessage } from "@/server/web/http";
import { createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

// Each sale is a real sandbox capture, so it is limited per shop and for everyone together.
const perShop = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
const everyone = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  if (!perShop(session.shopId) || !everyone("all")) return withMessage(request, "Too many sales from this shop. Try again in a while.");
  const form = await request.formData();
  try {
    await withCallLog(getDb(), session.shopId, () =>
      buyAsFamily(getDb(), payPalClientFromEnv(), {
        shopId: session.shopId,
        shopItemId: String(form.get("shopItemId") ?? ""),
        today: businessDay(),
        secret: secret("SHOP_DATA_KEY"),
        demoEmail: process.env.DEMO_BUYER_EMAIL || undefined,
      }),
    );
    return seeOther(request, "/queue");
  } catch (err) {
    if (err instanceof LiveSaleRefused) return withMessage(request, err.message);
    console.error("demo sale failed:", err instanceof Error ? err.message : "unknown error");
    return withMessage(request, "The sale did not go through. Try again.");
  }
}
