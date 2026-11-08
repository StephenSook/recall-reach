// Our own sandbox app bills shops. This never uses a connected seller's Auth-Assertion.
import { z } from "zod";
import type { PayPalClient } from "./client";
import { valueToCents } from "./orders";
import type { RecordKey } from "../privacy/recordKey";

export const SHOP_PLAN = { name: "Recall Reach for shops", value: "5.00", currency: "USD", interval: "MONTH" } as const;
const id = z.string().regex(/^[A-Za-z0-9-]{1,80}$/);
const statuses = z.enum(["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED"]);
const subscription = z.object({
  id, status: statuses, plan_id: id, custom_id: z.string(),
  start_time: z.iso.datetime({ offset: true }).optional(),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});
const createdSubscription = subscription.pick({ id: true, status: true, links: true });
export type SubscriptionStatus = z.infer<typeof statuses>;
export interface Subscription {
  id: string; status: SubscriptionStatus; planId: string; customId: string; startTime: string | null; approveUrl: string | null;
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error("PayPal's subscription answer could not be read");
  return result.data;
}

function pathId(value: string): string { return parse(id, value); }

export function sandboxApproveUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== "https://www.sandbox.paypal.com" || url.username || url.password) throw new Error("PayPal approval must use the sandbox");
  return url.href;
}

function facts(data: unknown): Subscription {
  const s = parse(subscription, data);
  const approve = s.links?.find((link) => link.rel === "approve");
  return { id: s.id, status: s.status, planId: s.plan_id, customId: s.custom_id, startTime: s.start_time ?? null, approveUrl: approve ? sandboxApproveUrl(approve.href) : null };
}

export const subscriptionCustomId = (key: RecordKey, shopId: string): string => key("paypal-subscription-shop", shopId);
export const subscriptionPlanId = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const value = env.PAYPAL_SUBSCRIPTION_PLAN_ID?.trim();
  return value && id.safeParse(value).success ? value : null;
};

/** Reuses the configured plan first. Without one, stable request ids recover an interrupted setup. Keep the printed id. */
export async function ensurePlan(client: PayPalClient, storedPlanId: string | null = subscriptionPlanId()): Promise<string> {
  if (storedPlanId) {
    const { data } = await client.request("GET", `/v1/billing/plans/${pathId(storedPlanId)}`);
    const p = parse(z.object({ id, status: z.literal("ACTIVE"), name: z.literal(SHOP_PLAN.name), billing_cycles: z.array(z.object({
      frequency: z.object({ interval_unit: z.literal(SHOP_PLAN.interval), interval_count: z.literal(1) }),
      tenure_type: z.literal("REGULAR"), total_cycles: z.literal(0),
      pricing_scheme: z.object({ fixed_price: z.object({
        value: z.string().regex(/^\d+(?:\.\d{1,2})?$/).transform(valueToCents).refine((cents) => cents === valueToCents(SHOP_PLAN.value)),
        currency_code: z.literal(SHOP_PLAN.currency),
      }) }),
    })).length(1),
    payment_preferences: z.object({ setup_fee: z.object({ value: z.string().regex(/^0+(?:\.0+)?$/) }).optional() }).optional(),
    taxes: z.object({ percentage: z.string().optional(), inclusive: z.boolean().optional() })
      .refine((taxes) => taxes.percentage === undefined || /^0+(?:\.0+)?$/.test(taxes.percentage) || taxes.inclusive === true).optional(),
    }), data);
    if (p.id !== storedPlanId) throw new Error("PayPal returned a different plan");
    return p.id;
  }
  const product = await client.request("POST", "/v1/catalogs/products", {
    requestId: "rr-shops-product-v1",
    body: { name: SHOP_PLAN.name, type: "SERVICE", category: "SOFTWARE" },
  });
  const productId = parse(z.object({ id }), product.data).id;
  const plan = await client.request("POST", "/v1/billing/plans", {
    requestId: "rr-shops-plan-v1",
    body: {
      product_id: productId, name: SHOP_PLAN.name, status: "ACTIVE",
      billing_cycles: [{ frequency: { interval_unit: SHOP_PLAN.interval, interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: SHOP_PLAN.value, currency_code: SHOP_PLAN.currency } } }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    },
  });
  return parse(z.object({ id, status: z.literal("ACTIVE") }), plan.data).id;
}

export async function createSubscription(client: PayPalClient, input: { shopId: string; recordKey: RecordKey; planId: string; requestId: string; site: string; notAfter: number }): Promise<Pick<Subscription, "id" | "status" | "approveUrl">> {
  const site = new URL(input.site);
  if (!["http:", "https:"].includes(site.protocol) || site.username || site.password || site.origin !== input.site) throw new Error("subscription returns need this site's origin");
  const { data } = await client.request("POST", "/v1/billing/subscriptions", {
    requestId: input.requestId,
    notAfter: input.notAfter,
    body: {
      plan_id: pathId(input.planId), custom_id: subscriptionCustomId(input.recordKey, input.shopId),
      application_context: { brand_name: "Recall Reach", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW",
        return_url: `${site.origin}/api/shop/subscription/return`, cancel_url: `${site.origin}/queue` },
    },
  });
  // POST can return only id/status/links. Ownership is confirmed by GET on the return, not assumed from this response.
  const s = parse(createdSubscription, data);
  const approve = s.links?.find((link) => link.rel === "approve");
  return { id: s.id, status: s.status, approveUrl: approve ? sandboxApproveUrl(approve.href) : null };
}

export async function readSubscription(client: PayPalClient, subscriptionId: string): Promise<Subscription> {
  const { data } = await client.request("GET", `/v1/billing/subscriptions/${pathId(subscriptionId)}`);
  const result = facts(data);
  if (result.id !== subscriptionId) throw new Error("PayPal returned a different subscription");
  return result;
}

export async function cancelSubscription(client: PayPalClient, subscriptionId: string, requestId: string): Promise<void> {
  await client.request("POST", `/v1/billing/subscriptions/${pathId(subscriptionId)}/cancel`, {
    requestId, body: { reason: "The shop owner cancelled Recall Reach for shops." },
  });
}
