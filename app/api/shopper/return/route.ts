import { getDb } from "@/server/db/pg";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { finishShopperOrder, SlipRefused } from "@/server/paypal/shopperOrder";
import { seeOther } from "@/server/web/http";

export const dynamic = "force-dynamic";

// Where PayPal sends the person back. It adds the order's id as "token". Nothing in this address is trusted: the order is read
// from PayPal before anything is captured or recorded.
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slip = params.get("slip") ?? "";
  try {
    await finishShopperOrder(getDb(), payPalClientFromEnv(), { slipId: slip, orderId: params.get("token") ?? "", now: new Date() });
    return seeOther(request, `/shopper/done?slip=${encodeURIComponent(slip)}`);
  } catch (err) {
    if (err instanceof SlipRefused) return seeOther(request, `/shopper?error=${err.code}`);
    console.error("shopper capture failed:", err instanceof Error ? err.name : "unknown error");
    return seeOther(request, "/shopper?error=FAILED");
  }
}
