import { returnShopSubscription } from "@/server/shop/subscription";
import { subscriptionRequest } from "@/server/shop/subscriptionHttp";
import { refused, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return subscriptionRequest(request, async ({ db, client, ...input }) => {
    const subscriptionId = new URL(request.url).searchParams.get("subscription_id");
    if (!subscriptionId || !/^[A-Za-z0-9-]{1,80}$/.test(subscriptionId)) return refused(400, "missing subscription id");
    const status = await returnShopSubscription(db, client, { ...input, subscriptionId });
    return withMessage(request, `PayPal reports ${status}. PayPal sandbox, no real charge. Everything that keeps families safe stays free.`);
  });
}
