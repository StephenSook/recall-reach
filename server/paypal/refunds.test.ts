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
import { PayPalApiError, type Method, type PayPalClient, type RequestOptions } from "./client";
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

/** A PayPal stand-in with one capture and a refund endpoint. */
function fakePayPal(over: { status?: string; amountCents?: number; createTime?: string; currency?: string; refundStatus?: string; refundError?: Error } = {}) {
  const calls: { method: Method; path: string; opts: RequestOptions }[] = [];
  let status = over.status ?? "COMPLETED";
  const value = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  const client: PayPalClient = {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      if (method === "GET" && path === "/v2/payments/captures/CAP-1") {
        return {
          status: 200,
          data: {
            id: "CAP-1",
            status,
            create_time: over.createTime ?? "2026-11-06T14:00:00Z",
            amount: { currency_code: over.currency ?? "USD", value: value(over.amountCents ?? 9000) },
          },
        };
      }
      if (method === "POST" && path === "/v2/payments/captures/CAP-1/refund") {
        if (over.refundError) throw over.refundError;
        status = "REFUNDED";
        return { status: 201, data: { id: "REF-1", status: over.refundStatus ?? "COMPLETED" } };
      }
      if (method === "GET" && path === "/v2/payments/refunds/REF-1") {
        return { status: 200, data: { id: "REF-1", status: "COMPLETED", amount: { currency_code: "USD", value: "90.00" } } };
      }
      throw new Error(`unexpected call ${method} ${path}`);
    }) as PayPalClient["request"],
  };
  return { client, calls };
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
      await execute(a.approvalId, fakePayPal({ refundError: new TypeError("network down") }).client);
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
      const r = await execute(a.approvalId, fakePayPal({ refundError: new PayPalApiError(422, "POST", "/x", "REFUND_AMOUNT_EXCEEDED") }).client);
      expect(r).toMatchObject({ status: "failed", failure: "REFUND_AMOUNT_EXCEEDED" });
    });

    it("records a lost answer as unconfirmed, never as failed: the money may have moved", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const r = await execute(a.approvalId, fakePayPal({ refundError: new TypeError("network down") }).client);
      expect(r.status).toBe("unconfirmed");
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

    it("marks a pending refund unconfirmed after 10 minutes with no webhook, and reads PayPal for the answer", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const r = await execute(a.approvalId, fakePayPal({ refundStatus: "PENDING" }).client);
      const later = new Date(NOW.getTime() + 11 * 60_000);
      const rec = await reconcileRefund(db, fakePayPal({ status: "REFUNDED" }).client, { shopId, refundId: r.refundId, recordKey: key, now: later });
      expect(rec.ledger.status).toBe("refunded"); // PayPal's GET says COMPLETED
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
