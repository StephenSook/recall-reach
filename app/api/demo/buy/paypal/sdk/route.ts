import { getDb } from "@/server/db/pg";
import { LiveSaleRefused, startPayPalBuy } from "@/server/demo/liveCatch";
import { withCallLog } from "@/server/paypal/callLog";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { baseUrl, currentSession, fromThisSite, refused, secret } from "@/server/web/http";
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
    const { orderId, returnUrl } = await withCallLog(getDb(), session.shopId, () => startPayPalBuy(getDb(), payPalClientFromEnv(), {
      shopId: session.shopId,
      sessionId: session.sessionId,
      shopItemId: String(form.get("shopItemId") ?? ""),
      siteUrl: baseUrl(request),
      sessionSecret: secret("SESSION_SECRET"),
    }));
    const state = new URL(returnUrl).searchParams.get("state");
    return Response.json({ orderId, state }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof LiveSaleRefused) return refused(409, err.message);
    return refused(502, "PayPal could not start the sale. Try again.");
  }
}
