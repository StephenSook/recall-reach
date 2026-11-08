// The platform side of PayPal: a shop connects its own PayPal account through Partner Referrals, and the platform then
// acts for it with PayPal-Auth-Assertion. Sandbox only, through the same client as everything else.
import { createPayPalClient, PayPalApiError, type PayPalClient } from "./client";
import { createTokenProvider } from "./token";

/** What a connected shop grants the platform. Transaction Search lets the shop's own file join to its own payments. */
export const REFERRAL_FEATURES = ["PAYMENT", "REFUND", "READ_SELLER_DISPUTE", "ADVANCED_TRANSACTIONS_SEARCH"] as const;

/** The OAuth scope PayPal lists for a granted refund. */
export const REFUND_SCOPE = "https://uri.paypal.com/services/payments/refund";

const MERCHANT_ID = /^[A-Z0-9]{8,20}$/;
const PAYPAL_SIGNUP = /^https:\/\/www\.(sandbox\.)?paypal\.com\//;

const b64url = (s: string) => Buffer.from(s).toString("base64url");

/** An unsigned JWT, as PayPal recommends: iss is the platform's client id, payer_id the seller's merchant id. */
export function authAssertion(platformClientId: string, sellerPayerId: string): string {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ iss: platformClientId, payer_id: sellerPayerId }))}.`;
}

export interface PlatformEnv {
  clientId: string;
  client: PayPalClient;
  partnerId: string;
  /** A client that acts for one connected shop: every request carries PayPal-Auth-Assertion for that seller. */
  actingFor(sellerMerchantId: string): PayPalClient;
}

/** Null when the platform app isn't set up here, so the page says so instead of failing. */
export function platformFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformEnv | null {
  const clientId = env.PAYPAL_PLATFORM_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_PLATFORM_CLIENT_SECRET?.trim();
  const partnerId = env.PAYPAL_PARTNER_MERCHANT_ID?.trim();
  if (!clientId || !clientSecret || !partnerId || !MERCHANT_ID.test(partnerId)) return null;
  const tokens = createTokenProvider({ clientId, clientSecret });
  return {
    clientId,
    partnerId,
    client: createPayPalClient({ tokens }),
    actingFor(sellerMerchantId: string) {
      if (!MERCHANT_ID.test(sellerMerchantId)) throw new Error("not a PayPal merchant id");
      // Our own client for every call, never the Toolkit or the Server SDK: neither sends PayPal-Auth-Assertion.
      return createPayPalClient({ tokens, headers: { "PayPal-Auth-Assertion": authAssertion(clientId, sellerMerchantId) } });
    },
  };
}

/** Starts a shop's connection. Throws PayPalApiError with PayPal's own answer when PayPal refuses. */
export async function createReferral(client: PayPalClient, input: { trackingId: string; returnUrl: string }): Promise<{ actionUrl: string }> {
  const { data } = await client.request<{ links?: { rel?: string; href?: string }[] }>("POST", "/v2/customer/partner-referrals", {
    body: {
      tracking_id: input.trackingId,
      operations: [
        {
          operation: "API_INTEGRATION",
          api_integration_preference: { rest_api_integration: { integration_method: "PAYPAL", integration_type: "THIRD_PARTY", third_party_details: { features: REFERRAL_FEATURES } } },
        },
      ],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      partner_config_override: { return_url: input.returnUrl },
    },
  });
  const href = data.links?.find((l) => l.rel === "action_url")?.href;
  if (!href || !PAYPAL_SIGNUP.test(href)) throw new Error("PayPal's answer had no sign-up link on paypal.com");
  return { actionUrl: href };
}

export interface SellerStatus {
  merchantId: string;
  paymentsReceivable: boolean;
  primaryEmailConfirmed: boolean;
  scopes: string[];
}

/**
 * Null while PayPal knows no seller for this tracking id: the shop hasn't finished signing up. Scopes count only when the
 * seller granted them to this platform's own app (platformClientId): another app's grant authorizes nothing here.
 */
export async function readSellerStatus(client: PayPalClient, input: { partnerId: string; trackingId: string; platformClientId: string }): Promise<SellerStatus | null> {
  let merchantId: unknown;
  try {
    ({ data: { merchant_id: merchantId } } = await client.request<{ merchant_id?: unknown }>("GET", `/v1/customer/partners/${input.partnerId}/merchant-integrations`, { query: { tracking_id: input.trackingId } }));
  } catch (err) {
    if (err instanceof PayPalApiError && err.status === 404) return null;
    throw err;
  }
  if (merchantId === undefined || merchantId === null || merchantId === "") return null;
  if (typeof merchantId !== "string" || !MERCHANT_ID.test(merchantId)) throw new Error("PayPal's answer had no merchant id in PayPal's form");
  const { data } = await client.request<{
    payments_receivable?: unknown;
    primary_email_confirmed?: unknown;
    oauth_integrations?: { oauth_third_party?: { partner_client_id?: unknown; scopes?: unknown[] }[] }[];
  }>("GET", `/v1/customer/partners/${input.partnerId}/merchant-integrations/${merchantId}`);
  const scopes = (data.oauth_integrations ?? []).flatMap((i) =>
    (i.oauth_third_party ?? []).filter((t) => t.partner_client_id === input.platformClientId).flatMap((t) => (t.scopes ?? []).filter((s): s is string => typeof s === "string")),
  );
  return { merchantId, paymentsReceivable: data.payments_receivable === true, primaryEmailConfirmed: data.primary_email_confirmed === true, scopes };
}

/** Connected only when PayPal's own answer says so: payments receivable, email confirmed, refunds granted. */
export const isConnected = (s: SellerStatus | null): boolean => Boolean(s && s.paymentsReceivable && s.primaryEmailConfirmed && s.scopes.includes(REFUND_SCOPE));
