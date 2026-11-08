import { getDb } from "@/server/db/pg";
import { cancelPayPalBuy, finishPayPalBuy, LiveSaleRefused } from "@/server/demo/liveCatch";
import { withCallLog } from "@/server/paypal/callLog";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { businessDay } from "@/server/time/businessDay";
import { currentSession, secret, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// Where PayPal sends the buyer back. It adds the order's id as "token". Neither that nor anything else in this address is
// trusted: the order is read from PayPal and must match before it is captured. Cancellation needs the signed state too.
export async function GET(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return seeOther(request, "/");
  const params = new URL(request.url).searchParams;
  try {
    if (params.has("cancelled")) {
      const released = await withCallLog(getDb(), session.shopId, () => cancelPayPalBuy(getDb(), {
        shopId: session.shopId,
        sessionId: session.sessionId,
        state: params.get("state") ?? "",
        sessionSecret: secret("SESSION_SECRET"),
        orderId: params.get("token") ?? undefined,
      }, params.has("token") ? payPalClientFromEnv() : undefined));
      return withMessage(request, released ? "You cancelled at PayPal. Nothing was sold." : "Nothing was cancelled here. If you paid at PayPal, the sale shows on your queue once PayPal confirms it.");
    }
    await withCallLog(getDb(), session.shopId, () => finishPayPalBuy(getDb(), payPalClientFromEnv(), {
      shopId: session.shopId,
      sessionId: session.sessionId,
      state: params.get("state") ?? "",
      orderId: params.get("token") ?? "",
      today: businessDay(),
      secret: secret("SHOP_DATA_KEY"),
      sessionSecret: secret("SESSION_SECRET"),
      demoEmail: process.env.DEMO_BUYER_EMAIL || undefined,
    }));
    return seeOther(request, "/queue");
  } catch (err) {
    if (err instanceof LiveSaleRefused) return withMessage(request, err.message);
    console.error("demo PayPal capture failed:", err instanceof Error ? err.message : "unknown error");
    return withMessage(request, "The sale did not go through. Try again.");
  }
}
