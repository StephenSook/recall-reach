import { getDb } from "@/server/db/pg";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { finishShopperOrder, SlipRefused } from "@/server/paypal/shopperOrder";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { refused, seeOther } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

const perVisitor = createRateLimiter({ limit: 30, windowMs: 60 * 60_000 });

// Where PayPal sends the person back. It adds the order's id as "token". Nothing in this address is trusted: the order is read
// from PayPal before anything is captured or recorded.
export async function GET(request: Request): Promise<Response> {
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor)) return seeOther(request, "/shopper?error=BUSY");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) return refused(503, "the server is missing its record key");
  const params = new URL(request.url).searchParams;
  const slip = params.get("slip") ?? "";
  try {
    await finishShopperOrder(getDb(), payPalClientFromEnv(), { slipId: slip, orderId: params.get("token") ?? "", recordKey, now: new Date() });
    return seeOther(request, `/shopper/done?slip=${encodeURIComponent(slip)}`);
  } catch (err) {
    // Money may be held, so this keeps the way back to this order. A new one would be a second payment.
    if (err instanceof SlipRefused && err.code === "HELD") return seeOther(request, `/shopper/done?slip=${encodeURIComponent(slip)}&token=${encodeURIComponent(params.get("token") ?? "")}&held=1`);
    if (err instanceof SlipRefused) return seeOther(request, `/shopper?error=${err.code}`);
    console.error("shopper capture failed:", err instanceof Error ? err.name : "unknown error");
    return seeOther(request, "/shopper?error=FAILED");
  }
}
