import { readCappedBody } from "@/server/http/body";
import { cancelShopSubscription } from "@/server/shop/subscription";
import { subscriptionRequest } from "@/server/shop/subscriptionHttp";
import { refused, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return subscriptionRequest(request, async ({ db, client, ...input }) => {
    const body = await readCappedBody(request, 2048);
    if (!body.ok) return refused(400, "form too large");
    const form = new URLSearchParams(Buffer.from(body.body).toString("utf8"));
    const subscriptionId = form.get("subscriptionId")?.trim() || undefined;
    if (subscriptionId && !/^[A-Za-z0-9-]{1,80}$/.test(subscriptionId)) return refused(400, "invalid subscription id");
    const result = await cancelShopSubscription(db, client, { ...input, subscriptionId });
    const message = result.alreadyClosed ? "This subscription was already cancelled or expired."
      : result.status === "CANCELLED" ? "Subscription cancelled."
      : result.status === "EXPIRED" ? "This subscription has expired."
      : `Cancel sent, but PayPal still reports ${result.status}. Check your PayPal sandbox account.`;
    return withMessage(request, `${message} PayPal sandbox, no real charge. Everything that keeps families safe stays free.`);
  });
}
