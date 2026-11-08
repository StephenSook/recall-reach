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
      if (path.startsWith("/v1/customer/partners/PARTNER12345/merchant-integrations/")) return { status: 200, data: answers.integration };
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

  it("keeps PayPal's newer seller when saving that seller's sales fails, and says why", async () => {
    const { env } = platform({ integration: READY });
    await startConnect(db, env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW });
    await db.query("alter table paypal_payments add constraint no_rows_here check (false)");
    const done = await refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW });
    expect(done).toEqual({ state: "CONNECTED", sales: { refusal: "The sales PayPal returned couldn't be saved here." } });
    expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBe("SELLERPAYER1");
    expect((await readConnection(db, { shopId, secret: SECRET }))?.refusal).toMatch(/^Connected, but the shop's sales couldn't be read\./);
  });

  it("reads a connected shop's sales against a deadline, so a slow PayPal can't hold the shop's lock for long", async () => {
    const deadlines: (number | undefined)[] = [];
    const { env } = platform({ integration: READY });
    const acting = env.actingFor("SELLERPAYER1");
    env.actingFor = () => ({ request: (async (m: string, path: string, opts?: { notAfter?: number }) => (path === "/v1/reporting/transactions" && deadlines.push(opts?.notAfter), acting.request(m as never, path, opts as never))) as PayPalClient["request"] });
    await startConnect(db, env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW });
    await refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW });
    expect(deadlines.length).toBeGreaterThan(0);
    expect(deadlines.every((d) => d === NOW.getTime() + 45_000)).toBe(true);
  });

  it("says nothing was started for a shop that never began connecting", async () => {
    const { env } = platform({ integration: READY });
    expect(await refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW })).toEqual({ state: "NOT_STARTED" });
  });

  const payments = async () => Number((await db.query<{ n: string }>("select count(*)::text as n from paypal_payments where shop_id = $1", [shopId])).rows[0].n);

  describe("when PayPal's webhook says a seller took its consent back", () => {
    const connected = async () => {
      const { env } = platform({ integration: READY });
      await startConnect(db, env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW });
      await refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW });
      expect((await readConnection(db, { shopId, secret: SECRET }))?.connected).toBe(true);
      expect(await payments()).toBeGreaterThan(0);
    };
    const revoke = (env: PlatformEnv, merchantId = "SELLERPAYER1") => confirmRevoked(db, env, { merchantId, recordKey: key, secret: SECRET });

    it("forgets the seller and its payments once PayPal's own status no longer shows refunds granted, keeping the row", async () => {
      await connected();
      const revoked = platform({ integration: { ...READY, oauth_integrations: [] } });
      expect(await revoke(revoked.env)).toEqual({ forgotten: 1, kept: 0, replaced: 0 });
      expect(await readConnection(db, { shopId, secret: SECRET })).toMatchObject({ connected: false, status: null });
      expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBeNull();
      expect(await payments()).toBe(0);
    });

    it("forgets the seller when PayPal knows no seller for the shop any more", async () => {
      await connected();
      const gone = platform({ status: new PayPalApiError(404, "GET", "/v1/customer/partners/{id}/merchant-integrations", "RESOURCE_NOT_FOUND", "d") });
      expect(await revoke(gone.env)).toEqual({ forgotten: 1, kept: 0, replaced: 0 });
    });

    it("keeps the link while PayPal's own status still says connected, so the event alone can't undo it", async () => {
      await connected();
      const still = platform({ integration: READY });
      expect(await revoke(still.env)).toEqual({ forgotten: 0, kept: 1, replaced: 0 });
      expect((await readConnection(db, { shopId, secret: SECRET }))?.connected).toBe(true);
    });

    it("changes nothing and fails, so PayPal sends the event again, when PayPal can't be read", async () => {
      await connected();
      const down = platform({ status: new PayPalApiError(503, "GET", "/v1/customer/partners/{id}/merchant-integrations", "SERVICE_UNAVAILABLE", "d") });
      await expect(revoke(down.env)).rejects.toThrow();
      expect((await readConnection(db, { shopId, secret: SECRET }))?.connected).toBe(true);
    });

    it("adopts the seller PayPal now shows for the shop, and drops the old seller's payments", async () => {
      await connected();
      const moved = platform({ status: { merchant_id: "SELLERPAYERB" }, integration: READY });
      expect(await revoke(moved.env)).toEqual({ forgotten: 0, kept: 0, replaced: 1 });
      expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBe("SELLERPAYERB");
      expect(await payments()).toBe(0);
    });

    it("touches no shop for a merchant it never linked", async () => {
      await connected();
      const { env } = platform({ integration: READY });
      expect(await revoke(env, "OTHERSELLER9")).toEqual({ forgotten: 0, kept: 0, replaced: 0 });
    });
  });

  describe("when checks overlap", () => {
    const NO_SELLER = () => new PayPalApiError(404, "GET", "/v1/customer/partners/{id}/merchant-integrations", "RESOURCE_NOT_FOUND", "d");
    // Each lookup by tracking id waits for an answer the test releases. Seller B's account has no sales.
    function racing() {
      const held: { release: (a: unknown) => void }[] = [];
      const waiters: (() => void)[] = [];
      const client = {
        request: vi.fn(async (_m: string, path: string) => {
          if (path === "/v2/customer/partner-referrals") return { status: 201, data: { links: [{ rel: "action_url", href: ACTION }] } };
          if (path === "/v1/customer/partners/PARTNER12345/merchant-integrations") {
            const answer = await new Promise<unknown>((release) => {
              held.push({ release });
              waiters.splice(0).forEach((w) => w());
            });
            if (answer instanceof Error) throw answer;
            return { status: 200, data: answer };
          }
          if (path.startsWith("/v1/customer/partners/PARTNER12345/merchant-integrations/")) return { status: 200, data: READY };
          throw new Error(`unexpected ${path}`);
        }),
      } as unknown as PayPalClient;
      const sellerA: PayPalClient = { request: (async (_m: string, path: string) => answerSearch(path) ?? Promise.reject(new Error(path))) as PayPalClient["request"] };
      const sellerB: PayPalClient = {
        request: (async (_m: string, path: string) => (path === "/v1/reporting/transactions" ? { status: 200, data: { transaction_details: [], total_pages: 1 } } : answerSearch(path) ?? Promise.reject(new Error(path)))) as PayPalClient["request"],
      };
      const env: PlatformEnv = { clientId: "platform-id", partnerId: "PARTNER12345", client, actingFor: (m) => (m === "SELLERPAYER1" ? sellerA : sellerB) };
      /** Resolves once n lookups have asked PayPal. */
      const asked = async (n: number) => {
        while (held.length < n) await new Promise<void>((r) => waiters.push(r));
      };
      return { env, held, asked };
    }
    const refresh = (env: PlatformEnv) => refreshConnection(db, env, { shopId, recordKey: key, secret: SECRET, now: NOW });
    const settle = () => new Promise((r) => setTimeout(r, 50));
    const begin = async (r: ReturnType<typeof racing>) => startConnect(db, r.env, { shopId, recordKey: key, returnUrl: "https://example.test/back", now: NOW });

    it("runs them one at a time: the second doesn't ask PayPal until the first has finished, and the one asked last stands", async () => {
      const r = racing();
      await begin(r);
      const first = refresh(r.env);
      await r.asked(1);
      const second = refresh(r.env);
      await settle();
      expect(r.held).toHaveLength(1);
      r.held[0].release({ merchant_id: "SELLERPAYER1" });
      expect(await first).toMatchObject({ state: "CONNECTED" });
      await r.asked(2);
      r.held[1].release(NO_SELLER());
      expect(await second).toEqual({ state: "WAITING" });
      expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBeNull();
      expect(await payments()).toBe(0);
    });

    it("finishes a seller's sales read before another check can change the seller, and drops them when it does", async () => {
      const r = racing();
      await begin(r);
      const first = refresh(r.env);
      await r.asked(1);
      const second = refresh(r.env);
      r.held[0].release({ merchant_id: "SELLERPAYER1" });
      // Read from its own answer: in-process Postgres has one connection, and the second check now holds it.
      const firstDone = await first;
      expect(firstDone).toMatchObject({ state: "CONNECTED", sales: { complete: true } });
      expect(firstDone.state === "CONNECTED" && "payments" in firstDone.sales && firstDone.sales.payments).toBeGreaterThan(0);
      await r.asked(2);
      r.held[1].release({ merchant_id: "SELLERPAYERB" });
      expect(await second).toMatchObject({ state: "CONNECTED", sales: { complete: true, payments: 0 } });
      expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBe("SELLERPAYERB");
      expect(await payments()).toBe(0);
    });

    it("lets a later check recover a link a revoke forgot, without connecting again", async () => {
      const r = racing();
      await begin(r);
      const setUp = refresh(r.env);
      await r.asked(1);
      r.held[0].release({ merchant_id: "SELLERPAYER1" });
      await setUp;
      const revoke = confirmRevoked(db, r.env, { merchantId: "SELLERPAYER1", recordKey: key, secret: SECRET });
      await r.asked(2);
      const later = refresh(r.env);
      await settle();
      expect(r.held).toHaveLength(2);
      r.held[1].release(NO_SELLER());
      expect(await revoke).toEqual({ forgotten: 1, kept: 0, replaced: 0 });
      await r.asked(3);
      r.held[2].release({ merchant_id: "SELLERPAYER1" });
      expect(await later).toMatchObject({ state: "CONNECTED" });
      expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBe("SELLERPAYER1");
    });

    it("applies two revokes in the order they asked, so the newer no-seller answer stands over an older kept", async () => {
      const r = racing();
      await begin(r);
      const setUp = refresh(r.env);
      await r.asked(1);
      r.held[0].release({ merchant_id: "SELLERPAYER1" });
      await setUp;
      const older = confirmRevoked(db, r.env, { merchantId: "SELLERPAYER1", recordKey: key, secret: SECRET });
      await r.asked(2);
      const newer = confirmRevoked(db, r.env, { merchantId: "SELLERPAYER1", recordKey: key, secret: SECRET });
      r.held[1].release({ merchant_id: "SELLERPAYER1" });
      expect(await older).toEqual({ forgotten: 0, kept: 1, replaced: 0 });
      await r.asked(3);
      r.held[2].release(NO_SELLER());
      expect(await newer).toEqual({ forgotten: 1, kept: 0, replaced: 0 });
      expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBeNull();
    });

    it("lets a reconnect wait for a check that is out, then fences anything older", async () => {
      const r = racing();
      await begin(r);
      const out = refresh(r.env);
      await r.asked(1);
      const again = begin(r);
      await settle();
      r.held[0].release({ merchant_id: "SELLERPAYER1" });
      expect(await out).toMatchObject({ state: "CONNECTED" });
      expect(await again).toEqual({ actionUrl: ACTION });
      expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBe("SELLERPAYER1");
    });
  });
});
