import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { PayPalApiError, type PayPalClient } from "../paypal/client";
import { REFUND_SCOPE, type PlatformEnv } from "../paypal/platform";
import { createRecordKey } from "../privacy/recordKey";
import { confirmRevoked, refreshConnection, startConnect } from "./connectFlow";
import { connectedMerchant, readConnection } from "./paypalConnection";

const key = createRecordKey("test-record-key-secret-0123456789abcdef");
const SECRET = "s".repeat(64);
const NOW = new Date("2026-11-08T03:00:00.000Z");
const ACTION = "https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=T";

function platform(answers: { referral?: unknown; status?: unknown; integration?: unknown }) {
  const actingCalls: string[] = [];
  const client = {
    request: vi.fn(async (method: string, path: string) => {
      if (path === "/v2/customer/partner-referrals") {
        if (answers.referral instanceof Error) throw answers.referral;
        return { status: 201, data: answers.referral ?? { links: [{ rel: "action_url", href: ACTION }] } };
      }
      if (path === "/v1/customer/partners/PARTNER12345/merchant-integrations") {
        if (answers.status instanceof Error) throw answers.status;
        return { status: 200, data: answers.status ?? { merchant_id: "SELLERPAYER1" } };
      }
      if (path === "/v1/customer/partners/PARTNER12345/merchant-integrations/SELLERPAYER1") return { status: 200, data: answers.integration };
      throw new Error(`unexpected ${method} ${path}`);
    }),
  } as unknown as PayPalClient;
  const acting: PayPalClient = {
    request: (async (_m: string, path: string) => {
      actingCalls.push(path);
      const found = answerSearch(path);
      if (found) return found;
      throw new Error(`unexpected ${path}`);
    }) as PayPalClient["request"],
  };
  const env: PlatformEnv = { clientId: "platform-id", partnerId: "PARTNER12345", client, actingFor: (m) => (m === "SELLERPAYER1" ? acting : (() => { throw new Error("wrong seller"); })()) };
  return { env, actingCalls };
}
const READY = { payments_receivable: true, primary_email_confirmed: true, oauth_integrations: [{ oauth_third_party: [{ partner_client_id: "platform-id", scopes: [REFUND_SCOPE] }] }] };

describe("connecting a shop's own PayPal account", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "A SHOP", kind: "REAL" });
  });
  afterEach(async () => {
    await db.close();
  });

  it("starts with PayPal's own sign-up link, telling PayPal only an HMAC of the shop", async () => {
    const { env } = platform({});
    expect(await startConnect(db, env, { shopId, recordKey: key, returnUrl: "https://example.test/api/shop/paypal/back", now: NOW })).toEqual({ actionUrl: ACTION });
    const body = (env.client.request as ReturnType<typeof vi.fn>).mock.calls[0][2].body;
    expect(body.tracking_id).toBe(key("paypal-tracking", shopId));
    expect(JSON.stringify(body)).not.toContain(shopId);
  });

  it("keeps PayPal's own words when it refuses, and doesn't work around it", async () => {
    const { env } = platform({ referral: new PayPalApiError(422, "POST", "/v2/customer/partner-referrals", "FEATURES_UNAUTHORIZED", "dbg42") });
    expect(await startConnect(db, env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW })).toEqual({ refusal: "PayPal answered HTTP 422, FEATURES_UNAUTHORIZED (PayPal-Debug-Id dbg42)" });
    expect((await readConnection(db, { shopId, secret: SECRET }))?.refusal).toBe("PayPal answered HTTP 422, FEATURES_UNAUTHORIZED (PayPal-Debug-Id dbg42)");
  });

  it("is connected only when PayPal's status says so, and then reads the shop's own sales acting for it", async () => {
    const { env, actingCalls } = platform({ integration: READY });
    await startConnect(db, env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW });
    const done = await refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW });
    expect(done).toMatchObject({ state: "CONNECTED", sales: { complete: true } });
    expect(actingCalls).toContain("/v1/reporting/transactions");
    expect((await readConnection(db, { shopId, secret: SECRET }))?.connected).toBe(true);
  });

  it("waits, and reads no sales, while PayPal knows no seller yet or the seller isn't ready", async () => {
    const notYet = platform({ status: new PayPalApiError(404, "GET", "/v1/customer/partners/{id}/merchant-integrations", "RESOURCE_NOT_FOUND", "d") });
    await startConnect(db, notYet.env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW });
    expect(await refreshConnection(db, notYet.env, { shopId, recordKey: key, secret: SECRET, now: NOW })).toEqual({ state: "WAITING" });
    const unready = platform({ integration: { ...READY, payments_receivable: false } });
    expect(await refreshConnection(db, unready.env, { shopId, recordKey: key, secret: SECRET, now: NOW })).toEqual({ state: "WAITING" });
    expect(unready.actingCalls).toEqual([]);
  });

  it("stops saying connected, and stops refunding from the seller, once PayPal no longer knows the seller", async () => {
    const { env } = platform({ integration: READY });
    await startConnect(db, env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW });
    await refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW });
    expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBe("SELLERPAYER1");
    const gone = platform({ status: new PayPalApiError(404, "GET", "/v1/customer/partners/{id}/merchant-integrations", "RESOURCE_NOT_FOUND", "d") });
    expect(await refreshConnection(db, gone.env, { shopId, recordKey: key, secret: SECRET, now: NOW })).toEqual({ state: "WAITING" });
    expect(await readConnection(db, { shopId, secret: SECRET })).toMatchObject({ connected: false, status: null });
    expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBeNull();
  });

  it("says nothing was started for a shop that never began connecting", async () => {
    const { env } = platform({ integration: READY });
    expect(await refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW })).toEqual({ state: "NOT_STARTED" });
  });

  describe("when PayPal's webhook says a seller took its consent back", () => {
    const connected = async () => {
      const { env } = platform({ integration: READY });
      await startConnect(db, env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW });
      await refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW });
      expect((await readConnection(db, { shopId, secret: SECRET }))?.connected).toBe(true);
    };

    it("forgets the link once PayPal's own status no longer shows refunds granted", async () => {
      await connected();
      const revoked = platform({ integration: { ...READY, oauth_integrations: [] } });
      expect(await confirmRevoked(db, revoked.env, { merchantId: "SELLERPAYER1", recordKey: key })).toEqual({ forgotten: 1, kept: 0 });
      expect(await readConnection(db, { shopId, secret: SECRET })).toBeNull();
    });

    it("forgets the link when PayPal knows no seller for the shop any more", async () => {
      await connected();
      const gone = platform({ status: new PayPalApiError(404, "GET", "/v1/customer/partners/{id}/merchant-integrations", "RESOURCE_NOT_FOUND", "d") });
      expect(await confirmRevoked(db, gone.env, { merchantId: "SELLERPAYER1", recordKey: key })).toEqual({ forgotten: 1, kept: 0 });
    });

    it("keeps the link while PayPal's own status still says connected, so the event alone can't undo it", async () => {
      await connected();
      const still = platform({ integration: READY });
      expect(await confirmRevoked(db, still.env, { merchantId: "SELLERPAYER1", recordKey: key })).toEqual({ forgotten: 0, kept: 1 });
      expect((await readConnection(db, { shopId, secret: SECRET }))?.connected).toBe(true);
    });

    it("keeps the link and fails, so PayPal sends the event again, when PayPal can't be read", async () => {
      await connected();
      const down = platform({ status: new PayPalApiError(503, "GET", "/v1/customer/partners/{id}/merchant-integrations", "SERVICE_UNAVAILABLE", "d") });
      await expect(confirmRevoked(db, down.env, { merchantId: "SELLERPAYER1", recordKey: key })).rejects.toThrow();
      expect((await readConnection(db, { shopId, secret: SECRET }))?.connected).toBe(true);
    });

    it("touches no shop for a merchant it never linked", async () => {
      await connected();
      const { env } = platform({ integration: READY });
      expect(await confirmRevoked(db, env, { merchantId: "OTHERSELLER9", recordKey: key })).toEqual({ forgotten: 0, kept: 0 });
    });
  });
});
