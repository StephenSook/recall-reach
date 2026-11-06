import { getDb } from "@/server/db/pg";
import { finishPayPalBuy, LiveSaleRefused } from "@/server/demo/liveCatch";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { businessDay } from "@/server/time/businessDay";
import { currentSession, secret, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// Where PayPal sends the buyer back. It adds the order's id as "token". Neither that nor anything else in this address is
// trusted: the order is read from PayPal before anything is written or captured.
export async function GET(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return seeOther(request, "/");
  const params = new URL(request.url).searchParams;
  if (params.has("cancelled")) return withMessage(request, "You cancelled at PayPal. Nothing was sold.");
  try {
    await finishPayPalBuy(getDb(), payPalClientFromEnv(), {
      shopId: session.shopId,
      state: params.get("state") ?? "",
      orderId: params.get("token") ?? "",
      today: businessDay(),
      secret: secret("SHOP_DATA_KEY"),
      sessionSecret: secret("SESSION_SECRET"),
      demoEmail: process.env.DEMO_BUYER_EMAIL || undefined,
    });
    return seeOther(request, "/queue");
  } catch (err) {
    if (err instanceof LiveSaleRefused) return withMessage(request, err.message);
    console.error("demo PayPal capture failed:", err instanceof Error ? err.message : "unknown error");
    return withMessage(request, "The sale did not go through. Try again.");
  }
}
