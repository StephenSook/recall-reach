import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { ImportedOrderLine } from "../import/shopExport";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import { createContactCipher } from "../privacy/contactCipher";
import { createRecordKey } from "../privacy/recordKey";
import { createPayPalClient, type PayPalClient } from "./client";
import { valueToCents } from "./orders";
import { approveRefund, askPayPalAgain, executeRefund, reconcileRefund, refundedAmount, RefundRefused, refundAmountCents } from "./refunds";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const NOW = new Date("2026-11-06T15:00:00Z");
const SESSION = "session-1";
const key = createRecordKey("test-record-key-secret-0123456789abcdef");
const PAPABLIC = "Papablic bedside sleeper, gray stars and moon"; // recall 27027, dated 2026-10-15

const line = (over: Partial<ImportedOrderLine> = {}): ImportedOrderLine => ({
  orderNumber: "#R1",
  lineNo: 1,
  title: PAPABLIC,
  sku: "PAPA-1",
  quantity: 1,
  unitPriceCents: 9000,
  discountCents: 0,
  currency: "USD",
  orderedOn: TODAY,
  paymentReference: null,
  buyerEmail: null,
  ...over,
});

/** What PayPal does with one refund POST. A number answers with that status and moves no money. */
type RefundStep = "land" | "lost" | "down" | number;

/**
 * PayPal at the HTTP level, behind the real client. It keeps PayPal's rules as measured on the sandbox
 * (2026-11-05): a repeated PayPal-Request-Id returns the original refund and moves no more money, even
 * if the amount differs; a refund above what is left gets 422 REFUND_AMOUNT_EXCEEDED; and a GET on any
 * refund reports the capture's total refunded so far. "lost" means the refund landed and the answer
 * never came back; "down" means it never arrived.
 */
function fakePayPal(
  over: {
    status?: string;
    amountCents?: number;
    createTime?: string;
    currency?: string;
    refundStatus?: string;
    refundSteps?: RefundStep[];
    captureReads?: (number | "down" | "ok")[];
    refundedElsewhereCents?: number;
  } = {},
) {
  const calls: { method: string; path: string; opts: { body?: unknown; requestId?: string } }[] = [];
  const value = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  const refusal = (status: number, issue: string) => Response.json({ name: "REFUSED", details: [{ issue }] }, { status });
  const amount = over.amountCents ?? 9000;
  const currency = over.currency ?? "USD";
  const steps = [...(over.refundSteps ?? [])];
  const captureReads = [...(over.captureReads ?? [])];
  const refunds = new Map<string, { id: string; captureId: string; status: string; cents: number }>();
  const refundedOn = new Map<string, number>();
  const statusOf = new Map<string, string>();
  const total = (captureId: string) => (refundedOn.get(captureId) ?? over.refundedElsewhereCents ?? 0);

  const land = (captureId: string, requestId: string, cents: number): { refund: { id: string; status: string }; replay: boolean } | Response => {
    const known = refunds.get(requestId);
    if (known) return { refund: known, replay: true };
    if (total(captureId) + cents > amount) return refusal(422, "REFUND_AMOUNT_EXCEEDED");
    const refund = { id: `REF-${refunds.size + 1}`, captureId, status: over.refundStatus ?? "COMPLETED", cents };
    refunds.set(requestId, refund);
    refundedOn.set(captureId, total(captureId) + cents);
    statusOf.set(captureId, refundedOn.get(captureId) === amount ? "REFUNDED" : "PARTIALLY_REFUNDED");
    return { refund, replay: false };
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const requestId = new Headers(init?.headers).get("PayPal-Request-Id") ?? undefined;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path: url.pathname, opts: { body, requestId } });

    const capture = /^\/v2\/payments\/captures\/([\w-]+)(\/refund)?$/.exec(url.pathname);
    if (capture && method === "GET") {
      const read = captureReads.shift();
      if (read === "down") throw new TypeError("network down");
      if (typeof read === "number") return refusal(read, "CAPTURE_READ_FAILED");
      return Response.json({
        id: capture[1],
        status: statusOf.get(capture[1]) ?? over.status ?? "COMPLETED",
        create_time: over.createTime ?? "2026-11-06T14:00:00Z",
        amount: { currency_code: currency, value: value(amount) },
      });
    }
    if (capture?.[2] && method === "POST") {
      const step = steps.shift() ?? "land";
      if (step === "down") throw new TypeError("network down");
      if (typeof step === "number") return refusal(step, step === 422 ? "REFUND_AMOUNT_EXCEEDED" : "SOMETHING");
      const landed = land(capture[1], requestId ?? "", valueToCents(body.amount.value));
      if (step === "lost") throw new TypeError("network down");
      if (landed instanceof Response) return landed;
      return Response.json({ id: landed.refund.id, status: landed.refund.status }, { status: landed.replay ? 200 : 201 });
    }
    const refund = /^\/v2\/payments\/refunds\/([\w-]+)$/.exec(url.pathname);
    const found = refund && method === "GET" ? [...refunds.values()].find((r) => r.id === refund[1]) : undefined;
    if (found) {
      return Response.json({
        id: found.id,
        status: found.status,
        amount: { currency_code: currency, value: value(found.cents) },
        seller_payable_breakdown: {
          gross_amount: { currency_code: currency, value: value(found.cents) },
          total_refunded_amount: { currency_code: currency, value: value(total(found.captureId)) },
        },
      });
    }
    throw new Error(`unexpected call ${method} ${url.pathname}`);
  };

  const client = createPayPalClient({
    tokens: { get: async () => "token", invalidate: () => {} },
    fetchImpl: fetchImpl as typeof fetch,
    sleep: async () => {},
  });
  return {
    client,
    calls,
    /** The refunds PayPal actually made, however many times it was asked. */
    made: () => [...refunds.values()],
    settle: (status: string) => refunds.forEach((r) => (r.status = status)),
    /** What the next refund POSTs will meet. */
    thenRefund: (...next: RefundStep[]) => steps.push(...next),
    thenCaptureReads: (...next: (number | "down" | "ok")[]) => captureReads.push(...next),
    posts: () => calls.filter((c) => c.method === "POST"),
  };
}

describe("refunds", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
  });
  afterEach(async () => {
    await db.close();
  });

  async function setUp(l: ImportedOrderLine = line(), payment: { orderNumber?: string | null; amountCents?: number } = {}) {
    await storeOrderLines(db, shopId, [l], createContactCipher("k".repeat(32), shopId), "test");
    await db.query(
      `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency)
       values ($1, 'ORDER-1', $2, 'CAP-1', 'COMPLETED', '2026-11-06T14:00:00Z', $3, 'USD')`,
      [shopId, payment.orderNumber === undefined ? l.orderNumber : payment.orderNumber, payment.amountCents ?? 9000],
    );
    await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
    const { rows } = await db.query<{ id: string; verdict: string; sale_path: string; join_state: string }>(
      `select m.id, m.verdict, m.sale_path, m.join_state from recall_matches m join recalls r using (recall_id)
       where m.shop_id = $1 and r.recall_number = '27027'`,
      [shopId],
    );
    return rows[0];
  }
  const approve = (matchId: string, sessionId = SESSION, now = NOW) => approveRefund(db, { shopId, sessionId, matchId, now });
  const execute = (approvalId: string, client: PayPalClient, sessionId = SESSION, now = NOW) =>
    executeRefund(db, client, { shopId, sessionId, approvalId, recordKey: key, now });
  /** The ledger row's age is measured from the test's clock, not the real one. */
  const agedFromNow = (refundId: string) => db.query("update refunds set created_at = $2::timestamptz where id = $1", [refundId, NOW.toISOString()]);
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => "no refusal",
      (e: unknown) => (e instanceof RefundRefused ? e.code : `other error: ${String(e)}`),
    );

  describe("the amount", () => {
    it("is line price times quantity, less the line's discount", () => {
      expect(refundAmountCents({ unitPriceCents: 3000, quantity: 2, discountCents: 750 })).toBe(5250);
    });
    it("is never below zero", () => {
      expect(refundAmountCents({ unitPriceCents: 100, quantity: 1, discountCents: 500 })).toBe(0);
    });
    it("renders with its currency", () => {
      expect(refundedAmount(9000, "USD")).toBe("90.00 USD");
    });
  });

  describe("approving", () => {
    it("binds the shop, session, recall version, line, amount and currency, for 15 minutes", async () => {
      const m = await setUp(line({ quantity: 2, unitPriceCents: 3000, discountCents: 750 }));
      const a = await approve(m.id);
      const { rows } = await db.query<Record<string, unknown>>("select * from approvals where id = $1", [a.approvalId]);
      expect(rows[0]).toMatchObject({ shop_id: shopId, session_id: SESSION, amount_cents: 5250, currency: "USD", consumed_at: null });
      expect((rows[0].expires_at as Date).getTime() - NOW.getTime()).toBe(15 * 60_000);
      const raw = await db.query<{ raw_sha256: string }>("select raw_sha256 from recalls where recall_number = '27027'");
      expect(rows[0].recall_sha256).toBe(raw.rows[0].raw_sha256);
      expect(a).toMatchObject({ amountCents: 5250, currency: "USD" });
    });

    it("refuses a sale from before the recall date", async () => {
      const m = await setUp(line({ orderedOn: "2026-09-01" }));
      expect(m.sale_path).toBe("NOTICE_ONLY");
      expect(await refusal(approve(m.id))).toBe("NOT_REFUND_ELIGIBLE");
    });

    it("refuses a sale on the recall's calendar date: that goes to review", async () => {
      const m = await setUp(line({ orderedOn: "2026-10-15" }));
      expect(m.sale_path).toBe("REVIEW");
      expect(await refusal(approve(m.id))).toBe("NOT_REFUND_ELIGIBLE");
    });

    it("refuses a join that is not identified", async () => {
      const m = await setUp(line(), { orderNumber: null });
      expect(m.join_state).not.toBe("IDENTIFIED");
      expect(await refusal(approve(m.id))).toBe("JOIN_NOT_IDENTIFIED");
    });

    it("refuses a scope gap: it needs a confirmed match", async () => {
      const m = await setUp(line({ title: "Papablic bedside sleeper" }));
      expect(m.verdict).toBe("SCOPE_GAP");
      expect(await refusal(approve(m.id))).toBe("NOT_A_CONFIRMED_MATCH");
    });

    it("refuses another shop's match", async () => {
      const m = await setUp();
      const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
      expect(await refusal(approveRefund(db, { shopId: other, sessionId: SESSION, matchId: m.id, now: NOW }))).toBe("NO_SUCH_MATCH");
    });

    it("refuses while an earlier refund for this line is not settled as failed", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      await execute(a.approvalId, fakePayPal({ refundSteps: ["down", "down", "down"] }).client);
      expect(await refusal(approve(m.id))).toBe("REFUND_ALREADY_IN_PROGRESS");
    });
  });

  describe("executing", () => {
    it("refunds the bound amount on the original capture, with a request id, and records it", async () => {
      const m = await setUp(line({ quantity: 2, unitPriceCents: 3000, discountCents: 750 }));
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      const post = pp.calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/v2/payments/captures/CAP-1/refund");
      expect(post?.opts.body).toEqual({ amount: { currency_code: "USD", value: "52.50" } });
      expect(post?.opts.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r).toMatchObject({ status: "refunded", amountCents: 5250, currency: "USD" });
      const { rows } = await db.query<Record<string, unknown>>("select * from refunds where id = $1", [r.refundId]);
      expect(rows[0]).toMatchObject({ status: "refunded", amount_cents: 5250, request_id: post?.opts.requestId, refund_ref_hmac: key("paypal-resource", "REF-1") });
      expect(JSON.stringify(rows[0])).not.toContain("REF-1");
      expect(JSON.stringify(rows[0])).not.toContain("CAP-1");
    });

    it("keeps the approval when PayPal cannot be read first: nothing was sent, so the seller can try again", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const down = fakePayPal({ captureReads: ["down", "down", "down"] });
      expect(await refusal(execute(a.approvalId, down.client))).toBe("PAYPAL_UNREACHABLE");
      expect(down.posts()).toEqual([]);
      const { rows: approvals } = await db.query<{ consumed_at: unknown }>("select consumed_at from approvals where id = $1", [a.approvalId]);
      expect(approvals[0].consumed_at).toBeNull();
      expect((await db.query("select 1 from refunds")).rows).toEqual([]);
      const healthy = fakePayPal();
      expect((await execute(a.approvalId, healthy.client)).status).toBe("refunded");
      expect(healthy.made()).toHaveLength(1);
    });

    it("keeps the approval when a check refuses, so a refused attempt uses up nothing", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      await db.query("update recalls set raw_sha256 = 'changed' where recall_number = '27027'");
      expect(await refusal(execute(a.approvalId, fakePayPal().client))).toBe("RECALL_CHANGED");
      const { rows } = await db.query<{ consumed_at: unknown }>("select consumed_at from approvals where id = $1", [a.approvalId]);
      expect(rows[0].consumed_at).toBeNull();
    });

    it("refuses with no approval on record", async () => {
      await setUp();
      const pp = fakePayPal();
      expect(await refusal(execute("00000000-0000-4000-8000-000000000000", pp.client))).toBe("APPROVAL_NOT_VALID");
      expect(pp.calls).toEqual([]);
    });

    it("refuses a malformed approval id without a database error", async () => {
      await setUp();
      expect(await refusal(execute("not-a-uuid", fakePayPal().client))).toBe("APPROVAL_NOT_VALID");
    });

    it("consumes an approval once: a replay is refused and moves no money", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const first = fakePayPal();
      await execute(a.approvalId, first.client);
      const second = fakePayPal();
      expect(await refusal(execute(a.approvalId, second.client))).toBe("APPROVAL_NOT_VALID");
      expect(second.calls).toEqual([]);
    });

    describe("one refund per order line", () => {
      // A $30 line on a $100 capture: PayPal alone would happily refund it twice.
      const roomy = () => fakePayPal({ amountCents: 10000 });
      const thirty = () => setUp(line({ unitPriceCents: 3000 }), { amountCents: 10000 });

      it("refuses a second approval once the first has made a refund", async () => {
        const m = await thirty();
        const first = await approve(m.id);
        const second = await approve(m.id);
        const pp = roomy();
        expect((await execute(first.approvalId, pp.client)).status).toBe("refunded");
        expect(await refusal(execute(second.approvalId, pp.client))).toBe("REFUND_ALREADY_IN_PROGRESS");
        expect(pp.posts()).toHaveLength(1);
        expect(pp.made()).toHaveLength(1);
      });

      it("lets only one of two approvals through when both run at once", async () => {
        const m = await thirty();
        const first = await approve(m.id);
        const second = await approve(m.id);
        const pp = roomy();
        const results = await Promise.allSettled([execute(first.approvalId, pp.client), execute(second.approvalId, pp.client)]);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(pp.made()).toHaveLength(1);
        const { rows } = await db.query("select 1 from refunds");
        expect(rows).toHaveLength(1);
      });

      it("lets one approval through once when it runs twice at the same moment", async () => {
        const m = await thirty();
        const a = await approve(m.id);
        const pp = roomy();
        const results = await Promise.allSettled([execute(a.approvalId, pp.client), execute(a.approvalId, pp.client)]);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(pp.made()).toHaveLength(1);
      });

      it("leaves the second approval unspent when it is refused for the line", async () => {
        const m = await thirty();
        const first = await approve(m.id);
        const second = await approve(m.id);
        await execute(first.approvalId, roomy().client);
        await refusal(execute(second.approvalId, roomy().client));
        const { rows } = await db.query<{ consumed_at: unknown }>("select consumed_at from approvals where id = $1", [second.approvalId]);
        expect(rows[0].consumed_at).toBeNull();
      });

      it("allows a new refund after PayPal clearly refused the last one", async () => {
        const m = await thirty();
        const first = await approve(m.id);
        await execute(first.approvalId, fakePayPal({ amountCents: 10000, refundSteps: [422] }).client);
        const second = await approve(m.id);
        const pp = roomy();
        expect((await execute(second.approvalId, pp.client)).status).toBe("refunded");
      });

      it("does not let two lines of one payment claim the same balance at once", async () => {
        await storeOrderLines(db, shopId, [line({ lineNo: 2, sku: "PAPA-2", unitPriceCents: 6000 })], createContactCipher("k".repeat(32), shopId), "test");
        await setUp(line({ unitPriceCents: 6000 }), { amountCents: 10000 });
        const { rows: matches } = await db.query<{ id: string }>(
          `select m.id from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '27027' order by m.id`,
          [shopId],
        );
        expect(matches).toHaveLength(2);
        const [a, b] = [await approve(matches[0].id), await approve(matches[1].id)];
        const pp = roomy();
        const results = await Promise.allSettled([execute(a.approvalId, pp.client), execute(b.approvalId, pp.client)]);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(pp.made()).toHaveLength(1);
      });

      it("the database itself refuses a second open refund for a line", async () => {
        const m = await thirty();
        const a = await approve(m.id);
        await execute(a.approvalId, roomy().client);
        const second = await approve(m.id).catch(() => null);
        expect(second).toBeNull();
        const { rows } = await db.query<{ approval_id: string; order_line_id: string }>("select approval_id, order_line_id from refunds");
        const fresh = await db.query<{ id: string }>(
          `insert into approvals (shop_id, session_id, recall_id, recall_sha256, order_line_id, amount_cents, currency, expires_at)
           select shop_id, session_id, recall_id, recall_sha256, order_line_id, amount_cents, currency, expires_at from approvals limit 1
           returning id`,
        );
        await expect(
          db.query("insert into refunds (approval_id, shop_id, order_line_id, amount_cents, currency, status) values ($1, $2, $3, 3000, 'USD', 'unconfirmed')", [
            fresh.rows[0].id,
            shopId,
            rows[0].order_line_id,
          ]),
        ).rejects.toThrow(/refunds_one_open_per_line/);
      });
    });

    it("refuses an approval from another session", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      expect(await refusal(execute(a.approvalId, pp.client, "another-session"))).toBe("APPROVAL_NOT_VALID");
      expect(pp.calls).toEqual([]);
    });

    it("refuses an expired approval", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const later = new Date(NOW.getTime() + 16 * 60_000);
      expect(await refusal(execute(a.approvalId, fakePayPal().client, SESSION, later))).toBe("APPROVAL_NOT_VALID");
    });

    it("refuses when CPSC changed the recall since the approval", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      await db.query("update recalls set raw_sha256 = 'changed' where recall_number = '27027'");
      const pp = fakePayPal();
      expect(await refusal(execute(a.approvalId, pp.client))).toBe("RECALL_CHANGED");
      expect(pp.calls).toEqual([]);
    });

    describe("a line corrected after the approval", () => {
      const reimport = (over: Partial<ImportedOrderLine>) => storeOrderLines(db, shopId, [line(over)], createContactCipher("k".repeat(32), shopId), "test");
      const changes: [string, Partial<ImportedOrderLine>][] = [
        ["the price", { unitPriceCents: 3000 }],
        ["the quantity", { quantity: 2 }],
        ["the discount", { discountCents: 500 }],
        ["the title", { title: `${PAPABLIC} XL` }],
        ["the SKU", { sku: "PAPA-2" }],
        ["the currency", { currency: "CAD" }],
        ["the order date", { orderedOn: "2026-11-05" }],
      ];
      it.each(changes)("refuses when %s changed, and moves no money", async (_field, over) => {
        const m = await setUp();
        const a = await approve(m.id);
        await reimport(over);
        const pp = fakePayPal();
        expect(await refusal(execute(a.approvalId, pp.client))).toBe("LINE_CHANGED");
        expect(pp.posts()).toEqual([]);
      });

      it("accepts a re-import that changed nothing the refund rests on", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        await reimport({});
        expect((await execute(a.approvalId, fakePayPal().client)).status).toBe("refunded");
      });

      it("accepts a fresh approval of the corrected line, for the corrected amount", async () => {
        const m = await setUp();
        await approve(m.id);
        await reimport({ unitPriceCents: 3000 });
        const a = await approve(m.id);
        expect(a.amountCents).toBe(3000);
        const pp = fakePayPal();
        expect((await execute(a.approvalId, pp.client)).amountCents).toBe(3000);
        expect(pp.posts()[0].opts.body).toEqual({ amount: { currency_code: "USD", value: "30.00" } });
      });
    });

    it("refuses past 180 days from the payment", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ createTime: "2026-05-01T00:00:00Z" });
      expect(await refusal(execute(a.approvalId, pp.client))).toBe("REFUND_WINDOW_CLOSED");
      expect(pp.calls.some((c) => c.method === "POST")).toBe(false);
    });

    it("refuses when the payment itself is not after the recall date, whatever the order date says", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ createTime: "2026-10-15T12:00:00Z" });
      expect(await refusal(execute(a.approvalId, pp.client))).toBe("PAYMENT_NOT_AFTER_RECALL");
    });

    it("refuses a currency that differs from the approved one", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      expect(await refusal(execute(a.approvalId, fakePayPal({ currency: "CAD" }).client))).toBe("PAYPAL_FACTS_CHANGED");
    });

    it("refuses a capture already fully refunded", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      expect(await refusal(execute(a.approvalId, fakePayPal({ status: "REFUNDED" }).client))).toBe("NOTHING_LEFT_TO_REFUND");
    });

    it("refuses an amount above what the capture has left", async () => {
      const m = await setUp(line({ unitPriceCents: 9000 }));
      const a = await approve(m.id);
      expect(await refusal(execute(a.approvalId, fakePayPal({ amountCents: 8000 }).client))).toBe("AMOUNT_ABOVE_REMAINING");
    });

    it("refuses a partly refunded capture it has no record of: only PayPal knows what is left", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      expect(await refusal(execute(a.approvalId, fakePayPal({ status: "PARTIALLY_REFUNDED" }).client))).toBe("REMAINING_UNKNOWN");
    });

    describe("the payment matching identified", () => {
      const addPayment = (orderNumber: string | null, captureId = "CAP-2", orderId = "ORDER-2") =>
        db.query(
          `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency)
           values ($1, $2, $3, $4, 'COMPLETED', '2026-11-06T14:00:00Z', 10000, 'USD')`,
          [shopId, orderId, orderNumber, captureId],
        );

      it("refuses when a second payment with the same order number has appeared", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        await addPayment("r1"); // normalizes to the same number as "#R1"
        const pp = fakePayPal({ amountCents: 10000 });
        expect(await refusal(execute(a.approvalId, pp.client))).toBe("PAYMENT_CHANGED");
        expect(pp.posts()).toEqual([]);
      });

      it("refuses when a different payment has taken its place", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        await db.query("delete from paypal_payments where shop_id = $1", [shopId]);
        await addPayment("#R1");
        const pp = fakePayPal({ amountCents: 10000 });
        expect(await refusal(execute(a.approvalId, pp.client))).toBe("PAYPAL_FACTS_AGED_OUT");
        expect(pp.posts()).toEqual([]);
      });

      it("refuses to approve once a second payment has appeared", async () => {
        const m = await setUp();
        await addPayment("r1");
        expect(await refusal(approve(m.id))).toBe("PAYMENT_CHANGED");
      });

      it("refunds a line that was linked by SKU, on that payment's capture", async () => {
        await storeOrderLines(db, shopId, [line({ orderNumber: "#S1", sku: "PAPA-SKU" })], createContactCipher("k".repeat(32), shopId), "test");
        await db.query(
          `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
           values ($1, 'ORDER-S', null, 'CAP-S', 'COMPLETED', '2026-11-06T14:00:00Z', 9000, 'USD', $2::jsonb)`,
          [shopId, JSON.stringify([{ name: "sleeper", sku: "PAPA-SKU" }])],
        );
        await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
        const { rows } = await db.query<{ id: string; join_state: string }>(
          `select m.id, m.join_state from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '27027'`,
          [shopId],
        );
        expect(rows[0].join_state).toBe("IDENTIFIED");
        const a = await approve(rows[0].id);
        const pp = fakePayPal();
        expect((await execute(a.approvalId, pp.client)).status).toBe("refunded");
        expect(pp.posts()[0].path).toBe("/v2/payments/captures/CAP-S/refund");
      });

      it("records which payment the match identified, as our own id and never PayPal's", async () => {
        const m = await setUp();
        const { rows } = await db.query<{ paypal_payment_id: string; own_id: string }>(
          `select m.paypal_payment_id, p.id as own_id from recall_matches m join paypal_payments p on p.shop_id = m.shop_id where m.id = $1`,
          [m.id],
        );
        expect(rows[0].paypal_payment_id).toBe(rows[0].own_id);
      });

      it("forgets the link when the purge removes the payment", async () => {
        const m = await setUp();
        await db.query("delete from paypal_payments where shop_id = $1", [shopId]);
        const { rows } = await db.query<{ paypal_payment_id: string | null; join_state: string }>(
          "select paypal_payment_id, join_state from recall_matches where id = $1",
          [m.id],
        );
        expect(rows[0]).toEqual({ paypal_payment_id: null, join_state: "IDENTIFIED" });
        expect(await refusal(approve(m.id))).toBe("PAYPAL_FACTS_AGED_OUT");
      });
    });

    it("refuses when PayPal's facts aged out, rather than guessing", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      await db.query("delete from paypal_payments where shop_id = $1", [shopId]);
      expect(await refusal(execute(a.approvalId, fakePayPal().client))).toBe("PAYPAL_FACTS_AGED_OUT");
    });

    it("records PayPal's refusal as failed, with its issue code", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const r = await execute(a.approvalId, fakePayPal({ refundSteps: [422] }).client);
      expect(r).toMatchObject({ status: "failed", failure: "REFUND_AMOUNT_EXCEEDED" });
    });

    it("records a lost answer as unconfirmed, never as failed: the money may have moved", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundSteps: ["lost", "lost", "lost"] });
      const r = await execute(a.approvalId, pp.client);
      expect(r.status).toBe("unconfirmed");
      expect(pp.posts()).toHaveLength(3);
      expect(pp.made()).toHaveLength(1); // every attempt carried one request id, so PayPal made one refund
    });

    describe("an answer that does not prove the money stayed put", () => {
      const outcomes: [string, RefundStep[]][] = [
        ["a lost answer, then 429 twice", ["lost", 429, 429]],
        ["a lost answer, then a 422", ["lost", 422]],
        ["a 500, then a 422", [500, 422]],
        ["429 on every attempt", [429, 429, 429]],
        ["409, a previous call still in progress", [409]],
      ];
      it.each(outcomes)("stays unconfirmed after %s", async (_name, refundSteps) => {
        const m = await setUp();
        const a = await approve(m.id);
        const r = await execute(a.approvalId, fakePayPal({ refundSteps }).client);
        expect(r.status).toBe("unconfirmed");
        expect(await refusal(approve(m.id))).toBe("REFUND_ALREADY_IN_PROGRESS");
      });

      it("stays unconfirmed on a refund status PayPal has not documented", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        expect((await execute(a.approvalId, fakePayPal({ refundStatus: "SOMETHING_NEW" }).client)).status).toBe("unconfirmed");
      });

      it("records a refund PayPal itself reports as failed, as failed", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        expect((await execute(a.approvalId, fakePayPal({ refundStatus: "FAILED" }).client)).status).toBe("failed");
      });
    });

    it("records PayPal's PENDING as pending", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      expect((await execute(a.approvalId, fakePayPal({ refundStatus: "PENDING" }).client)).status).toBe("pending");
    });
  });

  describe("asking PayPal again about a refund with no clear answer", () => {
    const again = (refundId: string, client: PayPalClient, now = NOW, shop = shopId) => askPayPalAgain(db, client, { shopId: shop, refundId, recordKey: key, now });
    /** The send that got no answer is over, so its lease has run out. */
    const LATER = new Date(NOW.getTime() + 5 * 60_000);

    async function noClearAnswer(refundSteps: RefundStep[]) {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundSteps });
      const r = await execute(a.approvalId, pp.client);
      await agedFromNow(r.refundId);
      expect(r.status).toBe("unconfirmed");
      return { m, r, pp };
    }

    it("finds a refund that landed when every answer was lost, and makes no second refund", async () => {
      const { r, pp } = await noClearAnswer(["lost", "lost", "lost"]);
      const first = pp.posts()[0];
      const after = await again(r.refundId, pp.client, LATER);
      expect(after.status).toBe("refunded");
      expect(pp.made()).toHaveLength(1);
      const last = pp.posts().at(-1);
      expect(last?.opts.requestId).toBe(first.opts.requestId);
      expect(last?.opts.body).toEqual(first.opts.body);
      expect(last?.path).toBe(first.path);
    });

    it("records PayPal's refund id once it is known, so the webhook and reconciliation can find it", async () => {
      const { r, pp } = await noClearAnswer(["lost", "lost", "lost"]);
      await again(r.refundId, pp.client, LATER);
      const { rows } = await db.query<{ refund_ref_hmac: string; refund_id: string }>(
        "select f.refund_ref_hmac, p.refund_id from refunds f join paypal_refund_refs p on p.refund_row_id = f.id where f.id = $1",
        [r.refundId],
      );
      expect(rows[0]).toEqual({ refund_ref_hmac: key("paypal-resource", "REF-1"), refund_id: "REF-1" });
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: LATER });
      expect(rec.refund?.status).toBe("COMPLETED");
      expect(rec.ledger.status).toBe("refunded");
    });

    it("sends the refund if it never arrived, still only once", async () => {
      const { r, pp } = await noClearAnswer(["down", "down", "down"]);
      expect(pp.made()).toHaveLength(0);
      expect((await again(r.refundId, pp.client, LATER)).status).toBe("refunded");
      expect(pp.made()).toHaveLength(1);
    });

    it("settles as failed on a clear refusal, which frees the line for a new approval", async () => {
      const { m, r } = await noClearAnswer(["down", "down", "down"]);
      const refusing = fakePayPal({ refundSteps: [422] });
      const after = await again(r.refundId, refusing.client, LATER);
      expect(after).toMatchObject({ status: "failed", failure: "REFUND_AMOUNT_EXCEEDED" });
      await expect(approve(m.id)).resolves.toBeDefined();
    });

    describe("what a refused repeat can and cannot prove", () => {
      const noProof: [number, RefundStep[]][] = [
        [401, [401, 401]],
        [403, [403]],
        [404, [404]],
      ];
      it.each(noProof)("stays unconfirmed on %s: that says nothing about the first send", async (_status, steps) => {
        const { m, r } = await noClearAnswer(["down", "down", "down"]);
        const after = await again(r.refundId, fakePayPal({ refundSteps: steps }).client, LATER);
        expect(after.status).toBe("unconfirmed");
        expect(await refusal(approve(m.id))).toBe("REFUND_ALREADY_IN_PROGRESS");
      });

      it("stays unconfirmed on a 422 when the capture shows money already refunded", async () => {
        const { m, r, pp } = await noClearAnswer(["lost", "lost", "lost"]);
        expect(pp.made()).toHaveLength(1);
        pp.thenRefund(422);
        const after = await again(r.refundId, pp.client, LATER);
        expect(after.status).toBe("unconfirmed");
        expect(await refusal(approve(m.id))).toBe("REFUND_ALREADY_IN_PROGRESS");
      });

      it("stays unconfirmed when the capture cannot be read after a 422", async () => {
        const { r } = await noClearAnswer(["down", "down", "down"]);
        const pp = fakePayPal({ refundSteps: [422], captureReads: ["down", "down", "down"] });
        expect((await again(r.refundId, pp.client, LATER)).status).toBe("unconfirmed");
      });
    });

    it("holds the lease for longer than the slowest possible send", async () => {
      // 3 attempts plus one after a token refresh, 60 s each; 2 token requests, 30 s each; 1.5 s of backoff.
      const SLOWEST_SEND_MS = 4 * 60_000 + 2 * 30_000 + 1_500;
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const leases: Date[] = [];
      const watching: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          if (method === "POST") {
            const { rows } = await db.query<{ send_lease_until: Date }>("select send_lease_until from refunds");
            leases.push(rows[0].send_lease_until);
          }
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
      await execute(a.approvalId, watching);
      expect(leases[0].getTime() - NOW.getTime()).toBeGreaterThan(SLOWEST_SEND_MS);
    });

    it("stays unconfirmed when PayPal still gives no clear answer", async () => {
      const { r } = await noClearAnswer(["down", "down", "down"]);
      const after = await again(r.refundId, fakePayPal({ refundSteps: ["down", "down", "down"] }).client, LATER);
      expect(after.status).toBe("unconfirmed");
    });

    it("does not send while the first send may still be running", async () => {
      const { r } = await noClearAnswer(["down", "down", "down"]);
      await db.query("update refunds set send_lease_until = $2::timestamptz where id = $1", [r.refundId, new Date(NOW.getTime() + 60_000).toISOString()]);
      const pp = fakePayPal();
      expect(await refusal(again(r.refundId, pp.client))).toBe("REFUND_BEING_SENT");
      expect(pp.posts()).toEqual([]);
    });

    it("lets only one of two simultaneous requests send", async () => {
      const { r } = await noClearAnswer(["down", "down", "down"]);
      const pp = fakePayPal();
      const results = await Promise.allSettled([again(r.refundId, pp.client, LATER), again(r.refundId, pp.client, LATER)]);
      expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(pp.posts()).toHaveLength(1);
    });

    it("refuses once the request is too old for PayPal's replay to be trusted", async () => {
      const { r } = await noClearAnswer(["down", "down", "down"]);
      const pp = fakePayPal();
      const tooLate = new Date(NOW.getTime() + 6 * 3_600_000 + 60_000);
      expect(await refusal(again(r.refundId, pp.client, tooLate))).toBe("TOO_OLD_TO_ASK_AGAIN");
      expect(pp.posts()).toEqual([]);
    });

    it("refuses when the line changed since the approval, rather than sending the old amount", async () => {
      const { r } = await noClearAnswer(["down", "down", "down"]);
      await storeOrderLines(db, shopId, [line({ unitPriceCents: 3000 })], createContactCipher("k".repeat(32), shopId), "test");
      const pp = fakePayPal();
      expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("LINE_CHANGED");
      expect(pp.posts()).toEqual([]);
    });

    it("refuses when the 46-hour purge removed the capture reference", async () => {
      const { r } = await noClearAnswer(["down", "down", "down"]);
      await db.query("delete from paypal_refund_refs");
      const pp = fakePayPal();
      expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("PAYPAL_FACTS_AGED_OUT");
      expect(pp.posts()).toEqual([]);
    });

    it("refuses a refund that already has a clear answer, and sends nothing", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      const posts = pp.posts().length;
      expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("NOTHING_TO_ASK");
      expect(pp.posts()).toHaveLength(posts);
    });

    it("refuses another shop's refund", async () => {
      const { r } = await noClearAnswer(["down", "down", "down"]);
      const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
      expect(await refusal(again(r.refundId, fakePayPal().client, LATER, other))).toBe("NO_SUCH_REFUND");
    });

    it("recovers a send that crashed before any answer, once reconciliation has flagged it", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const r = await execute(a.approvalId, fakePayPal({ refundSteps: ["down", "down", "down"] }).client);
      await agedFromNow(r.refundId);
      // What a crash mid-send leaves behind: a row still pending, no refund id.
      await db.query("update refunds set status = 'pending', send_lease_until = $2::timestamptz where id = $1", [r.refundId, new Date(NOW.getTime() + 240_000).toISOString()]);
      const pp = fakePayPal();
      const later = new Date(NOW.getTime() + 11 * 60_000);
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: later });
      expect(rec.ledger.status).toBe("unconfirmed");
      expect(rec.canAskAgain).toBe(true);
      expect((await again(r.refundId, pp.client, later)).status).toBe("refunded");
    });
  });

  describe("reconciling", () => {
    it("shows capture, refund, webhook and ledger side by side, with no exceptions when they agree", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      await db.query(
        `insert into paypal_webhook_events (event_id_hmac, event_type, resource_type, resource_id_hmac, verification_method)
         values ('e', 'PAYMENT.CAPTURE.REFUNDED', 'refund', $1, 'self')`,
        [key("paypal-resource", "REF-1")],
      );
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(rec).toEqual({
        canAskAgain: false,
        ledger: { status: "refunded", amountCents: 9000, currency: "USD" },
        capture: { status: "REFUNDED", amountCents: 9000, currency: "USD" },
        refund: { status: "COMPLETED", amountCents: 9000, currency: "USD" },
        webhook: { seen: true },
        exceptions: [],
      });
    });

    it("names the exception when no webhook has arrived", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(rec.webhook.seen).toBe(false);
      expect(rec.exceptions).toEqual(["PayPal's webhook has not arrived yet."]);
    });

    it("marks a pending refund unconfirmed after 10 minutes with no webhook and no answer from PayPal", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundStatus: "PENDING" });
      const r = await execute(a.approvalId, pp.client);
      await agedFromNow(r.refundId);
      const later = new Date(NOW.getTime() + 11 * 60_000);
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: later });
      expect(rec.ledger.status).toBe("unconfirmed");
      expect(rec.exceptions).toContain("No clear answer from PayPal yet. Check it before trying again.");
    });

    it("keeps a pending refund pending before those 10 minutes are up", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundStatus: "PENDING" });
      const r = await execute(a.approvalId, pp.client);
      await agedFromNow(r.refundId);
      const soon = new Date(NOW.getTime() + 9 * 60_000);
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: soon });
      expect(rec.ledger.status).toBe("pending");
    });

    it("follows PayPal's answer when a pending refund completes", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundStatus: "PENDING" });
      const r = await execute(a.approvalId, pp.client);
      pp.settle("COMPLETED");
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(rec.ledger.status).toBe("refunded");
    });

    it("refuses another shop's refund", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
      expect(await refusal(reconcileRefund(db, pp.client, { shopId: other, refundId: r.refundId, recordKey: key, now: NOW }))).toBe("NO_SUCH_REFUND");
    });
  });
});
