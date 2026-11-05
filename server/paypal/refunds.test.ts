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
import { approveRefund, executeRefund, reconcileRefund, refundedAmount, RefundRefused, refundAmountCents } from "./refunds";

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
    captureReads?: (number | "down")[];
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
      if (read !== undefined) return refusal(read, "CAPTURE_READ_FAILED");
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

    it("records PayPal's PENDING as pending", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      expect((await execute(a.approvalId, fakePayPal({ refundStatus: "PENDING" }).client)).status).toBe("pending");
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
