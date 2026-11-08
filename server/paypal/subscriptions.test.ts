import { describe, expect, it, vi } from "vitest";
import { createPayPalClient, PayPalApiError, type PayPalClient } from "./client";
import { createRecordKey } from "../privacy/recordKey";
import { cancelSubscription, createSubscription, ensurePlan, readSubscription, sandboxApproveUrl, SHOP_PLAN, subscriptionCustomId } from "./subscriptions";

const key = createRecordKey("subscription-test-secret-0123456789abcdef");
const raw = { id: "I-TEST-SUB", plan_id: "P-TEST", status: "APPROVAL_PENDING", custom_id: subscriptionCustomId(key, "shop"), links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=test" }] };
const input = { shopId: "shop", recordKey: key, planId: "P-TEST", requestId: "stable-request", site: "https://recall.example", notAfter: Date.now() + 60_000 };
const plan = { id: "P-TEST", status: "ACTIVE", name: SHOP_PLAN.name, billing_cycles: [{ frequency: { interval_unit: SHOP_PLAN.interval, interval_count: 1 }, tenure_type: "REGULAR", total_cycles: 0, pricing_scheme: { fixed_price: { value: SHOP_PLAN.value, currency_code: SHOP_PLAN.currency } } }] };
function mockClient(data: unknown = raw) {
  const request = vi.fn(async (...args: unknown[]) => { void args; return { status: 201, data }; });
  return { client: { request } as PayPalClient, request };
}

describe("sandbox subscription wrappers", () => {
  it("creates a product and a monthly plan with stable request ids and the only price constant", async () => {
    const { client, request } = mockClient();
    request.mockResolvedValueOnce({ status: 201, data: { id: "PROD-TEST" } }).mockResolvedValueOnce({ status: 201, data: { id: "P-TEST", status: "ACTIVE" } });
    expect(await ensurePlan(client, null)).toBe("P-TEST");
    expect(request).toHaveBeenNthCalledWith(1, "POST", "/v1/catalogs/products", { requestId: "rr-shops-product-v1", body: { name: SHOP_PLAN.name, type: "SERVICE", category: "SOFTWARE" } });
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/v1/billing/plans", expect.objectContaining({ requestId: "rr-shops-plan-v1", body: expect.objectContaining({ product_id: "PROD-TEST", status: "ACTIVE", billing_cycles: [{ frequency: { interval_unit: SHOP_PLAN.interval, interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: SHOP_PLAN.value, currency_code: SHOP_PLAN.currency } } }] }) }));
    const created = request.mock.calls[1][2] as { body: Record<string, unknown> };
    request.mockResolvedValue({ status: 200, data: { ...created.body, id: "P-TEST" } });
    expect(await ensurePlan(client, "P-TEST")).toBe("P-TEST");
  });

  it("reads a stored plan before attempting any POST and checks its terms", async () => {
    const { client, request } = mockClient(plan);
    expect(await ensurePlan(client, "P-TEST")).toBe("P-TEST");
    expect(request.mock.calls).toEqual([["GET", "/v1/billing/plans/P-TEST"]]);
    request.mockResolvedValue({ status: 200, data: { ...plan, status: "INACTIVE" } });
    await expect(ensurePlan(client, "P-TEST")).rejects.toThrow(/could not be read/);
  });

  it.each(["5", "5.0", "5.00"])("accepts the monthly price written as %s", async (value) => {
    const { client } = mockClient({ ...plan, billing_cycles: [{ ...plan.billing_cycles[0], pricing_scheme: { fixed_price: { value, currency_code: "USD" } } }] });
    expect(await ensurePlan(client, "P-TEST")).toBe("P-TEST");
  });

  it.each([
    ["5.01", "USD"], ["05.00x", "USD"], ["", "USD"], ["5.00", "usd"], ["5.00", "EUR"],
  ])("refuses the monthly price %s %s", async (value, currency_code) => {
    const { client, request } = mockClient({ ...plan, billing_cycles: [{ ...plan.billing_cycles[0], pricing_scheme: { fixed_price: { value, currency_code } } }] });
    await expect(ensurePlan(client, "P-TEST")).rejects.toThrow(/could not be read/);
    expect(request.mock.calls).toEqual([["GET", "/v1/billing/plans/P-TEST"]]);
  });

  it.each([
    { payment_preferences: { setup_fee: { value: "99.00", currency_code: "USD" } } },
    { payment_preferences: { setup_fee: {} } },
    { payment_preferences: { setup_fee: { currency_code: "USD" } } },
    { taxes: { percentage: "10", inclusive: false } },
    { taxes: { percentage: "10" } },
    { billing_cycles: [{ ...plan.billing_cycles[0], tenure_type: "TRIAL" }] },
    { billing_cycles: [{ ...plan.billing_cycles[0], total_cycles: 12 }] },
    { billing_cycles: [{ ...plan.billing_cycles[0], tenure_type: undefined }] },
    { billing_cycles: [{ ...plan.billing_cycles[0], total_cycles: undefined }] },
  ])("refuses terms that differ from the advertised monthly agreement: %j", async (terms) => {
    const { client, request } = mockClient({ ...plan, ...terms });
    await expect(ensurePlan(client, "P-TEST")).rejects.toThrow(/could not be read/);
    expect(request.mock.calls).toEqual([["GET", "/v1/billing/plans/P-TEST"]]);
  });

  it.each([
    { payment_preferences: {} },
    { payment_preferences: { setup_fee: { value: "0.00", currency_code: "USD" } } },
    { taxes: { percentage: "0", inclusive: false } },
    { taxes: { percentage: "0.00" } },
    { taxes: { percentage: "10", inclusive: true } },
  ])("accepts terms that add no charge to the displayed price: %j", async (terms) => {
    const { client } = mockClient({ ...plan, ...terms });
    expect(await ensurePlan(client, "P-TEST")).toBe("P-TEST");
  });

  it("creates with shop HMAC, same-site return/cancel, no shipping, and no buyer details", async () => {
    const { client, request } = mockClient({ ...raw, subscriber: { email_address: "private@example.test" } });
    const result = await createSubscription(client, input);
    expect(result).toEqual({ id: raw.id, status: raw.status, approveUrl: raw.links[0].href });
    expect(request).toHaveBeenCalledWith("POST", "/v1/billing/subscriptions", { requestId: input.requestId, notAfter: input.notAfter, body: { plan_id: input.planId, custom_id: raw.custom_id, application_context: { brand_name: "Recall Reach", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW", return_url: `${input.site}/api/shop/subscription/return`, cancel_url: `${input.site}/queue` } } });
    expect(raw.custom_id).not.toBe(input.shopId);
    expect(subscriptionCustomId(key, "another-shop")).not.toBe(raw.custom_id);
    expect(JSON.stringify(result)).not.toContain("private@example.test");
  });

  it("accepts a minimal create response, without assuming that it carries ownership fields", async () => {
    const { client } = mockClient({ id: raw.id, status: raw.status, links: raw.links });
    expect(await createSubscription(client, input)).toEqual({ id: raw.id, status: raw.status, approveUrl: raw.links[0].href });
  });

  it.each(["https://www.paypal.com/approve", "https://www.sandbox.paypal.com.evil.test/approve", "http://www.sandbox.paypal.com/approve", "https://evil@www.sandbox.paypal.com/approve", "https://www.sandbox.paypal.com:444/approve"])("refuses a non-sandbox approval URL: %s", async (href) => {
    const { client } = mockClient({ ...raw, links: [{ rel: "approve", href }] });
    await expect(createSubscription(client, input)).rejects.toThrow();
    expect(() => sandboxApproveUrl(href)).toThrow();
  });

  it("reads only the used fields and refuses malformed, wrong-id and path-changing answers", async () => {
    const { client, request } = mockClient({ ...raw, status: "ACTIVE", start_time: "2026-11-08T12:00:00Z" });
    expect(await readSubscription(client, raw.id)).toMatchObject({ status: "ACTIVE", startTime: "2026-11-08T12:00:00Z" });
    expect(request).toHaveBeenCalledWith("GET", `/v1/billing/subscriptions/${raw.id}`);
    await expect(readSubscription(client, "../other")).rejects.toThrow();
    request.mockResolvedValue({ status: 200, data: { ...raw, id: "I-OTHER" } });
    await expect(readSubscription(client, raw.id)).rejects.toThrow(/different subscription/);
    request.mockResolvedValue({ status: 200, data: { ...raw, status: "PAID" } });
    await expect(readSubscription(client, raw.id)).rejects.toThrow(/could not be read/);
  });

  it("cancels with an explicit request id and handles an empty 204 response", async () => {
    const { client, request } = mockClient(undefined);
    request.mockResolvedValue({ status: 204, data: undefined });
    await expect(cancelSubscription(client, raw.id, "cancel-request")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("POST", `/v1/billing/subscriptions/${raw.id}/cancel`, { requestId: "cancel-request", body: { reason: "The shop owner cancelled Recall Reach for shops." } });
  });

  it("puts request ids on the actual wire, keeps sandbox base, and uses no seller assertion", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(init?.method === "POST" ? JSON.stringify(raw) : "", { status: 201 }));
    const client = createPayPalClient({ tokens: { get: async () => "token", invalidate: () => {} }, fetchImpl });
    await createSubscription(client, input);
    await cancelSubscription(client, raw.id, "cancel-request");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(["https://api-m.sandbox.paypal.com/v1/billing/subscriptions", `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${raw.id}/cancel`]);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { Authorization: "Bearer token", "Content-Type": "application/json", "PayPal-Request-Id": "stable-request" },
      { Authorization: "Bearer token", "Content-Type": "application/json", "PayPal-Request-Id": "cancel-request" },
    ]);
  });

  it("templates subscription, product and plan ids even if they contain no digits", () => {
    for (const path of ["/v1/billing/subscriptions/I-SECRET/cancel", "/v1/billing/plans/P-SECRET", "/v1/catalogs/products/PROD-SECRET"]) {
      expect(new PayPalApiError(400, "POST", path).message).not.toContain("SECRET");
    }
  });
});
