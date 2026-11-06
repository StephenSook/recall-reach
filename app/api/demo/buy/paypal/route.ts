import { getDb } from "@/server/db/pg";
import { LiveSaleRefused, startPayPalBuy } from "@/server/demo/liveCatch";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { baseUrl, currentSession, fromThisSite, refused, secret, withMessage } from "@/server/web/http";
import { createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

const perShop = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
const everyone = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

// Sends the buyer to PayPal's own approval page. The sale is only written when they come back approved.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  if (!perShop(session.shopId) || !everyone("all")) return withMessage(request, "Too many sales from this shop. Try again in a while.");
  const form = await request.formData();
  try {
    const { approveUrl } = await startPayPalBuy(getDb(), payPalClientFromEnv(), {
      shopId: session.shopId,
      shopItemId: String(form.get("shopItemId") ?? ""),
      siteUrl: baseUrl(request),
      sessionSecret: secret("SESSION_SECRET"),
    });
    return new Response(null, { status: 303, headers: { Location: approveUrl } });
  } catch (err) {
    if (err instanceof LiveSaleRefused) return withMessage(request, err.message);
    console.error("demo PayPal order failed:", err instanceof Error ? err.message : "unknown error");
    return withMessage(request, "PayPal could not start the sale. Try again.");
  }
}
