import { subscriptionPlanId } from "@/server/paypal/subscriptions";
import { startShopSubscription } from "@/server/shop/subscription";
import { subscriptionRequest } from "@/server/shop/subscriptionHttp";
import { withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return subscriptionRequest(request, async ({ db, client, ...input }) => {
    const planId = subscriptionPlanId();
    if (!planId) return withMessage(request, "Shop subscriptions are not set up: PAYPAL_SUBSCRIPTION_PLAN_ID is missing. PayPal sandbox, no real charge. Everything that keeps families safe stays free.");
    const approve = await startShopSubscription(db, client, { ...input, planId });
    return approve ? new Response(null, { status: 303, headers: { location: approve, "cache-control": "no-store" } }) : withMessage(request, "Your subscription status was checked. PayPal sandbox, no real charge. Everything that keeps families safe stays free.");
  });
}
