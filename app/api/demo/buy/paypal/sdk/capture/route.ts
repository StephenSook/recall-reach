import { getDb } from "@/server/db/pg";
import { finishPayPalBuy, LiveSaleRefused } from "@/server/demo/liveCatch";
import { withCallLog } from "@/server/paypal/callLog";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { businessDay } from "@/server/time/businessDay";
import { currentSession, fromThisSite, refused, secret } from "@/server/web/http";
import { createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

const perShop = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
const everyone = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  if (!perShop(session.shopId) || !everyone("all")) return refused(429, "Too many sales from this shop. Try again in a while.");
  try {
    const form = await request.formData();
    await withCallLog(getDb(), session.shopId, () => finishPayPalBuy(getDb(), payPalClientFromEnv(), {
      shopId: session.shopId,
      sessionId: session.sessionId,
      state: String(form.get("state") ?? ""),
      orderId: String(form.get("orderId") ?? ""),
      today: businessDay(),
      secret: secret("SHOP_DATA_KEY"),
      sessionSecret: secret("SESSION_SECRET"),
      demoEmail: process.env.DEMO_BUYER_EMAIL || undefined,
    }));
    return Response.json({ captured: true }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof LiveSaleRefused) return refused(409, err.message);
    return refused(502, "The sale did not go through. Try again.");
  }
}
