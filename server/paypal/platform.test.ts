import { describe, expect, it, vi } from "vitest";
import { PayPalApiError, type PayPalClient } from "./client";
import { authAssertion, createReferral, isConnected, readSellerStatus, REFERRAL_FEATURES, REFUND_SCOPE } from "./platform";

const fakeClient = (answers: Record<string, unknown | Error>) => {
  const request = vi.fn(async (method: string, path: string, opts?: { body?: unknown; query?: Record<string, string> }) => {
    const key = `${method} ${path}`;
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`unexpected ${key} ${JSON.stringify(opts ?? {})}`);
    return { status: 200, data: answer };
  });
  return { client: { request } as unknown as PayPalClient, request };
};

const b64url = (s: string) => Buffer.from(s).toString("base64url");

describe("acting for a connected shop", () => {
  it("builds PayPal-Auth-Assertion as an unsigned JWT naming the platform and the seller", () => {
    const jwt = authAssertion("PLATFORM-CLIENT", "SELLERPAYER1");
    expect(jwt).toBe(`${b64url('{"alg":"none"}')}.${b64url('{"iss":"PLATFORM-CLIENT","payer_id":"SELLERPAYER1"}')}.`);
    expect(jwt.split(".")).toHaveLength(3);
  });
});

describe("a partner referral", () => {
  it("asks for third-party payments, refunds, dispute reads and transaction search, and comes back to the shop's queue", async () => {
    const { client, request } = fakeClient({ "POST /v2/customer/partner-referrals": { links: [{ rel: "self", href: "https://api-m.sandbox.paypal.com/v2/x" }, { rel: "action_url", href: "https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=T" }] } });
    const made = await createReferral(client, { trackingId: "shop-hmac-1", returnUrl: "https://example.test/queue?paypal=back" });
    expect(made.actionUrl).toBe("https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=T");
    const body = request.mock.calls[0][2]?.body as Record<string, unknown>;
    expect(body).toEqual({
      tracking_id: "shop-hmac-1",
      operations: [{ operation: "API_INTEGRATION", api_integration_preference: { rest_api_integration: { integration_method: "PAYPAL", integration_type: "THIRD_PARTY", third_party_details: { features: REFERRAL_FEATURES } } } }],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      partner_config_override: { return_url: "https://example.test/queue?paypal=back" },
    });
    expect(REFERRAL_FEATURES).toEqual(["PAYMENT", "REFUND", "READ_SELLER_DISPUTE", "ADVANCED_TRANSACTIONS_SEARCH"]);
  });

  it("refuses an answer with no sign-up link, or one not on PayPal's own site", async () => {
    await expect(createReferral(fakeClient({ "POST /v2/customer/partner-referrals": { links: [] } }).client, { trackingId: "t", returnUrl: "https://example.test/q" })).rejects.toThrow(/sign-up link/);
    await expect(createReferral(fakeClient({ "POST /v2/customer/partner-referrals": { links: [{ rel: "action_url", href: "https://evil.example/x" }] } }).client, { trackingId: "t", returnUrl: "https://example.test/q" })).rejects.toThrow(/sign-up link/);
  });
});

describe("a seller's status", () => {
  const integration = {
    merchant_id: "SELLERPAYER1",
    payments_receivable: true,
    primary_email_confirmed: true,
    oauth_integrations: [{ integration_type: "OAUTH_THIRD_PARTY", oauth_third_party: [{ partner_client_id: "P", scopes: [REFUND_SCOPE, "https://uri.paypal.com/services/payments/realtimepayment"] }] }],
  };

  it("is read by tracking id, then by the seller's merchant id, and says what PayPal said", async () => {
    const { client, request } = fakeClient({
      "GET /v1/customer/partners/PARTNER1/merchant-integrations": { merchant_id: "SELLERPAYER1", tracking_id: "shop-hmac-1" },
      "GET /v1/customer/partners/PARTNER1/merchant-integrations/SELLERPAYER1": integration,
    });
    const status = await readSellerStatus(client, { partnerId: "PARTNER1", trackingId: "shop-hmac-1", platformClientId: "P" });
    expect(request.mock.calls[0][2]).toMatchObject({ query: { tracking_id: "shop-hmac-1" } });
    expect(status).toEqual({ merchantId: "SELLERPAYER1", paymentsReceivable: true, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE, "https://uri.paypal.com/services/payments/realtimepayment"] });
    expect(isConnected(status)).toBe(true);
  });

  it("counts only what the seller granted this platform's own app, never another app's grant", async () => {
    const { client } = fakeClient({
      "GET /v1/customer/partners/PARTNER1/merchant-integrations": { merchant_id: "SELLERPAYER1" },
      "GET /v1/customer/partners/PARTNER1/merchant-integrations/SELLERPAYER1": {
        ...integration,
        oauth_integrations: [{ integration_type: "OAUTH_THIRD_PARTY", oauth_third_party: [{ partner_client_id: "OTHER-APP", scopes: [REFUND_SCOPE] }, { partner_client_id: "P", scopes: [] }] }],
      },
    });
    const status = await readSellerStatus(client, { partnerId: "PARTNER1", trackingId: "shop-hmac-1", platformClientId: "P" });
    expect(status?.scopes).toEqual([]);
    expect(isConnected(status)).toBe(false);
  });

  it("is nothing yet when PayPal knows no seller for the tracking id", async () => {
    const notYet = new PayPalApiError(404, "GET", "/v1/customer/partners/{id}/merchant-integrations", "RESOURCE_NOT_FOUND", "dbg1");
    const { client } = fakeClient({ "GET /v1/customer/partners/PARTNER1/merchant-integrations": notYet });
    expect(await readSellerStatus(client, { partnerId: "PARTNER1", trackingId: "t", platformClientId: "P" })).toBeNull();
  });

  it("isn't connected unless payments are receivable, the email is confirmed and refunds were granted", () => {
    const base = { merchantId: "S", paymentsReceivable: true, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE] };
    expect(isConnected({ ...base, paymentsReceivable: false })).toBe(false);
    expect(isConnected({ ...base, primaryEmailConfirmed: false })).toBe(false);
    expect(isConnected({ ...base, scopes: [] })).toBe(false);
    expect(isConnected(null)).toBe(false);
  });

  it("refuses a merchant id that isn't PayPal's form, so nothing odd lands in a path", async () => {
    const { client } = fakeClient({ "GET /v1/customer/partners/PARTNER1/merchant-integrations": { merchant_id: "../../x" } });
    await expect(readSellerStatus(client, { partnerId: "PARTNER1", trackingId: "t", platformClientId: "P" })).rejects.toThrow(/merchant id/);
  });
});
