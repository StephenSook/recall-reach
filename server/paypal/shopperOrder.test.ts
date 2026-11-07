import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import type { TextCheckAnswer } from "../match/textCheck";
import type { BuyableListing } from "../sweep/channel3";
import { createRecordKey } from "../privacy/recordKey";
import { PayPalApiError, type PayPalClient } from "./client";
import { cartHash, createSlip, finishShopperOrder, readFinishedSlip, SlipRefused, startShopperOrder } from "./shopperOrder";

const NOW = new Date("2026-11-07T15:00:00Z");
const LISTING: BuyableListing = { id: "raw-tub", title: "Folding Tub", brand: "Acme", priceCents: 2499, currency: "USD" };
const key = createRecordKey("test-record-key-secret-0123456789abcdef");
const clear: TextCheckAnswer = { results: [], more: 0, cleared: 0, notJudged: 0, checked: { recalls: 1855, from: "2022-01-03", to: "2026-11-05", yearsMissing: [] }, note: "" };

function fakePayPal(over: { failCreate?: boolean; order?: (invoice: string) => Record<string, unknown> } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let invoice = "";
  let captured = false;
  const client: PayPalClient = {
    request: (async (method: string, path: string, opts: { body?: { purchase_units?: { invoice_id: string }[] } } = {}) => {
      calls.push({ method, path, body: opts.body });
      if (method === "POST" && path === "/v2/checkout/orders") {
        if (over.failCreate) throw new PayPalApiError(500, "POST", path, "DOWN");
        invoice = opts.body?.purchase_units?.[0].invoice_id ?? "";
        return { status: 200, data: { id: "ORDER1", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] } };
      }
      if (method === "POST") {
        captured = true;
        return { status: 201, data: {} };
      }
      const unit = {
        invoice_id: invoice,
        amount: { currency_code: "USD", value: "24.99" },
        ...(captured ? { payments: { captures: [{ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "24.99" }, create_time: NOW.toISOString() }] } } : {}),
      };
      return { status: 200, data: { id: "ORDER1", status: captured ? "COMPLETED" : "APPROVED", purchase_units: [unit], ...over.order?.(invoice) } };
    }) as PayPalClient["request"],
  };
  return { client, calls, posts: () => calls.filter((c) => c.method === "POST") };
}

describe("an offer from the shopping agent", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  const deps = (over: Partial<{ read: (id: string) => Promise<BuyableListing | null>; check: (l: BuyableListing) => Promise<TextCheckAnswer> }> = {}) => ({ read: async () => LISTING, check: async () => clear, ...over });
  const start = (slipId: string, client: PayPalClient, over = {}, now = NOW) => startShopperOrder(db, client, { slipId, siteUrl: "https://site.test", recordKey: key, now }, deps(over));
  const code = (p: Promise<unknown>) => p.then(() => "no refusal", (err: unknown) => (err instanceof SlipRefused ? err.code : `other: ${String(err)}`));

  it("hashes each part apart, so moved characters make another cart", () => {
    expect(cartHash({ ...LISTING, id: "a", title: "bc" })).not.toBe(cartHash({ ...LISTING, id: "ab", title: "c" }));
    expect(cartHash({ ...LISTING, priceCents: 1 })).not.toBe(cartHash(LISTING));
  });

  it("starts a PayPal order at the listing's own price, with no ship-to and a sandbox label", async () => {
    const { id } = await createSlip(db, LISTING, NOW);
    const pp = fakePayPal();
    expect((await start(id, pp.client)).approveUrl).toContain("sandbox.paypal.com");
    const body = pp.posts()[0].body as { purchase_units: { invoice_id: string; amount: { value: string }; items: { name: string; unit_amount: { value: string } }[] }[]; payment_source: { paypal: { experience_context: { brand_name: string; shipping_preference: string; return_url: string } } } };
    const unit = body.purchase_units[0];
    expect(unit.amount.value).toBe("24.99");
    expect(unit.items[0]).toMatchObject({ name: "Folding Tub", unit_amount: { value: "24.99" } });
    expect(unit.invoice_id).toBe(`SHOP-${id.replace(/-/g, "")}`);
    expect(body.payment_source.paypal.experience_context).toMatchObject({ brand_name: "RECALL REACH SANDBOX TEST", shipping_preference: "NO_SHIPPING", return_url: `https://site.test/api/shopper/return?slip=${id}` });
  });

  it("works once", async () => {
    const { id } = await createSlip(db, LISTING, NOW);
    const pp = fakePayPal();
    await start(id, pp.client);
    expect(await code(start(id, pp.client))).toBe("EXPIRED");
    expect(pp.posts()).toHaveLength(1);
  });

  it("two presses at once start one order", async () => {
    const { id } = await createSlip(db, LISTING, NOW);
    const pp = fakePayPal();
    const results = await Promise.all([code(start(id, pp.client)), code(start(id, pp.client))]);
    expect(results.sort()).toEqual(["EXPIRED", "no refusal"]);
    expect(pp.posts()).toHaveLength(1);
  });

  it("runs out after ten minutes", async () => {
    const { id } = await createSlip(db, LISTING, NOW);
    const pp = fakePayPal();
    expect(await code(start(id, pp.client, {}, new Date(NOW.getTime() + 10 * 60_000 + 1)))).toBe("EXPIRED");
    expect(pp.posts()).toEqual([]);
  });

  it.each([
    ["the price moved", { ...LISTING, priceCents: 2599 }],
    ["the title changed", { ...LISTING, title: "Other Tub" }],
  ])("starts nothing if %s", async (_name, live) => {
    const { id } = await createSlip(db, LISTING, NOW);
    const pp = fakePayPal();
    expect(await code(start(id, pp.client, { read: async () => live }))).toBe("CHANGED");
    expect(pp.posts()).toEqual([]);
  });

  it("starts nothing if the listing is gone or can't be read", async () => {
    const { id } = await createSlip(db, LISTING, NOW);
    expect(await code(start(id, fakePayPal().client, { read: async () => null }))).toBe("GONE");
    const second = await createSlip(db, LISTING, NOW);
    expect(await code(start(second.id, fakePayPal().client, { read: async () => Promise.reject(new Error("down")) }))).toBe("GONE");
  });

  it.each([
    ["a recall names it now", { ...clear, results: [{ recallNumber: "1", title: "t", recallDate: "d", url: null, verdict: "MATCH", strength: "CONFIRMED", tiedToRecall: true, reason: "r", missing: [] }] } as TextCheckAnswer],
    ["a recall names its maker and line now", { ...clear, results: [{ recallNumber: "1", title: "t", recallDate: "d", url: null, verdict: "SCOPE_GAP", strength: "BRAND", tiedToRecall: true, reason: "r", missing: [] }] } as TextCheckAnswer],
    ["a code close to a recalled model shows now", { ...clear, results: [{ recallNumber: "1", title: "t", recallDate: "d", url: null, verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS", tiedToRecall: true, reason: "r", missing: [] }] } as TextCheckAnswer],
    ["the check couldn't finish", { ...clear, notJudged: 1 }],
    ["a year didn't load", { ...clear, checked: { ...clear.checked, yearsMissing: [2025] } }],
  ])("starts nothing if %s", async (_name, answer) => {
    const { id } = await createSlip(db, LISTING, NOW);
    const pp = fakePayPal();
    expect(await code(start(id, pp.client, { check: async () => answer }))).toBe("NOW_FLAGGED");
    expect(pp.posts()).toEqual([]);
  });

  it("isn't stopped by a recall of the same kind of product", async () => {
    const { id } = await createSlip(db, LISTING, NOW);
    const similar = { ...clear, results: [{ recallNumber: "1", title: "t", recallDate: "d", url: null, verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS", tiedToRecall: false, reason: "r", missing: [] }] } as TextCheckAnswer;
    expect(await code(start(id, fakePayPal().client, { check: async () => similar }))).toBe("no refusal");
  });

  it("asks PayPal with the slip's own id, so a retry after a lost answer can't make a second order", async () => {
    const { id } = await createSlip(db, LISTING, NOW);
    const seen: (string | undefined)[] = [];
    const client: PayPalClient = {
      request: (async (_m: string, _p: string, opts: { requestId?: string }) => {
        seen.push(opts.requestId);
        if (seen.length === 1) throw new PayPalApiError(500, "POST", "/v2/checkout/orders", "LOST");
        return { status: 200, data: { id: "ORDER1", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] } };
      }) as PayPalClient["request"],
    };
    await expect(start(id, client)).rejects.toBeInstanceOf(PayPalApiError);
    await start(id, client);
    expect(seen).toEqual([id, id]);
  });

  it("gives the slip back when PayPal can't make the order, since nothing happened", async () => {
    const { id } = await createSlip(db, LISTING, NOW);
    await expect(start(id, fakePayPal({ failCreate: true }).client)).rejects.toBeInstanceOf(PayPalApiError);
    expect(await code(start(id, fakePayPal().client))).toBe("no refusal");
  });

  it.each(["not-a-uuid", "00000000-0000-4000-8000-000000000001"])("refuses a slip that isn't one: %s", async (slip) => {
    expect(await code(start(slip, fakePayPal().client))).toBe("NO_SLIP");
  });

  it("clears out old slips as new ones are made", async () => {
    await createSlip(db, LISTING, new Date(NOW.getTime() - 49 * 3_600_000));
    await createSlip(db, LISTING, NOW);
    expect((await db.query("select 1 from shopping_slips")).rows).toHaveLength(1);
  });

  describe("back from PayPal", () => {
    const started = async (pp = fakePayPal()) => {
      const { id } = await createSlip(db, LISTING, NOW);
      await start(id, pp.client);
      return { id, pp };
    };
    const finish = (id: string, client: PayPalClient, orderId = "ORDER1") => finishShopperOrder(db, client, { slipId: id, orderId, recordKey: key, now: NOW });

    it("captures once approved, and reads as done only when PayPal's order and capture say COMPLETED", async () => {
      const { id, pp } = await started();
      expect(await readFinishedSlip(db, id)).toBeNull();
      await finish(id, pp.client);
      expect(pp.posts().map((c) => c.path)).toEqual(["/v2/checkout/orders", "/v2/checkout/orders/ORDER1/capture"]);
      expect(await readFinishedSlip(db, id)).toEqual({ title: "Folding Tub", priceCents: 2499, currency: "USD" });
    });

    it("a reload changes nothing and captures nothing again", async () => {
      const { id, pp } = await started();
      await finish(id, pp.client);
      await finish(id, pp.client);
      expect(pp.posts()).toHaveLength(2);
    });

    it.each([
      ["another slip's order", { purchase_units: [{ invoice_id: "SHOP-other", amount: { currency_code: "USD", value: "24.99" } }] }],
      ["another amount", (invoice: string) => ({ purchase_units: [{ invoice_id: invoice, amount: { currency_code: "USD", value: "1.00" } }] })],
      ["an order not approved", (invoice: string) => ({ status: "CREATED", purchase_units: [{ invoice_id: invoice, amount: { currency_code: "USD", value: "24.99" } }] })],
    ])("won't take %s", async (_name, order) => {
      const pp = fakePayPal({ order: typeof order === "function" ? order : () => order });
      const { id } = await started(pp);
      expect(await code(finish(id, pp.client))).toBe("NOT_PAID");
      expect(await readFinishedSlip(db, id)).toBeNull();
      expect(pp.posts()).toHaveLength(1);
    });

    it("says PayPal is holding it when the capture is pending, so nobody starts a second order, and finishes when read again", async () => {
      let held = true;
      const pp = fakePayPal({
        order: (invoice) => (held ? { status: "COMPLETED", purchase_units: [{ invoice_id: invoice, amount: { currency_code: "USD", value: "24.99" }, payments: { captures: [{ id: "C1", status: "PENDING", amount: { currency_code: "USD", value: "24.99" }, create_time: NOW.toISOString() }] } }] } : {}),
      });
      const { id } = await started(pp);
      expect(await code(finish(id, pp.client))).toBe("HELD");
      expect(await readFinishedSlip(db, id)).toBeNull();
      expect(pp.posts()).toHaveLength(1);
      held = false;
      await finish(id, pp.client);
      expect(await readFinishedSlip(db, id)).not.toBeNull();
    });

    it("isn't done if the capture doesn't read back complete", async () => {
      const pp = fakePayPal({ order: (invoice) => ({ status: "APPROVED", purchase_units: [{ invoice_id: invoice, amount: { currency_code: "USD", value: "24.99" } }] }) });
      const { id } = await started(pp);
      expect(await code(finish(id, pp.client))).toBe("NOT_PAID");
      expect(await readFinishedSlip(db, id)).toBeNull();
    });

    it("won't read PayPal for an order this slip didn't start", async () => {
      const { id, pp } = await started();
      const before = pp.calls.length;
      expect(await code(finish(id, pp.client, "SOME-OTHER-ORDER"))).toBe("NOT_PAID");
      expect(pp.calls).toHaveLength(before);
      expect(JSON.stringify((await db.query("select * from shopping_slips")).rows)).not.toContain("ORDER1");
    });

    it("won't finish a slip nobody started", async () => {
      const { id } = await createSlip(db, LISTING, NOW);
      expect(await code(finish(id, fakePayPal().client))).toBe("NOT_PAID");
    });
  });
});
