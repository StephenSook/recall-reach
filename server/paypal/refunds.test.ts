import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { approveRefund, askPayPalAgain, executeRefund, readRefund, reconcileRefund, refundedAmount, RefundRefused, refundAmountCents, sendSellerToPayPal } from "./refunds";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const NOW = new Date("2026-11-06T15:00:00Z");
const SESSION = "session-1";
const key = createRecordKey("test-record-key-secret-0123456789abcdef");
const PAPABLIC = "Papablic bedside sleeper, gray stars and moon"; // recall 27027, dated 2026-10-15
/** Built from CPSC's record for 27027, the recall the person approved. */
const REFUND_NOTE = "Refund for a recalled product. CPSC recall 27027: Papablic Bedside Sleepers with Play Yard Extensions. Follow the recall steps at cpsc.gov/Recalls.";

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
    /** What PayPal's Disputes API answers for this capture. "down" means it can't be reached. */
    disputes?: { status?: string }[] | "down";
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
    if (url.pathname === "/v1/customer/disputes" && method === "GET") {
      if (over.disputes === "down") throw new TypeError("network down");
      return Response.json({ items: over.disputes ?? [] });
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
    /** A refund someone made in PayPal itself. PayPal's totals include it; this app has no row for it. */
    refundElsewhere: (cents: number, captureId = "CAP-1") => {
      refundedOn.set(captureId, total(captureId) + cents);
      statusOf.set(captureId, refundedOn.get(captureId) === amount ? "REFUNDED" : "PARTIALLY_REFUNDED");
    },
    /** What the next refund POSTs will meet. */
    thenRefund: (...next: RefundStep[]) => steps.push(...next),
    thenCaptureReads: (...next: (number | "down" | "ok")[]) => captureReads.push(...next),
    posts: () => calls.filter((c) => c.method === "POST"),
  };
}

/** Holds one kind of PayPal answer back until the test lets it through, so an older answer can arrive late. */
function heldBack(client: PayPalClient, holds: (method: string, path: string) => boolean) {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const held: PayPalClient = {
    request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
      if (!holds(method, path)) return client.request(method, path, opts);
      const answer = await client.request(method, path, opts).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      arrived();
      await gate;
      if ("error" in answer) throw answer.error;
      return answer.value;
    }) as PayPalClient["request"],
  };
  return { client: held, reached, release };
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
  const approve = (matchId: string, sessionId = SESSION, now = NOW, client: PayPalClient = fakePayPal({ amountCents: 100000 }).client) =>
    approveRefund(db, client, { shopId, sessionId, matchId, now });
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

    it("refuses an order with a row that could not be read: its amount cannot be trusted", async () => {
      const m = await setUp(line({ orderIncomplete: true }));
      const message = await approve(m.id).catch((e: unknown) => (e instanceof RefundRefused ? `${e.code}: ${e.message}` : String(e)));
      expect(message).toBe("ORDER_INCOMPLETE: A row of this order could not be read, so this amount cannot be trusted. Fix the file and import it again.");
    });

    it("allows it once the shop's file is fixed and imported again", async () => {
      const m = await setUp(line({ orderIncomplete: true }));
      await storeOrderLines(db, shopId, [line()], createContactCipher("k".repeat(32), shopId), "test");
      await expect(approve(m.id)).resolves.toBeDefined();
    });

    it("refuses a match with no recorded strength, until the check runs again", async () => {
      const m = await setUp();
      await db.query("update recall_matches set strength = null where id = $1", [m.id]);
      expect(await refusal(approve(m.id))).toBe("NOT_A_CONFIRMED_MATCH");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      await expect(approve(m.id)).resolves.toBeDefined();
    });

    it("refuses a scope gap: it needs a confirmed match", async () => {
      const m = await setUp(line({ title: "Papablic bedside sleeper" }));
      expect(m.verdict).toBe("SCOPE_GAP");
      expect(await refusal(approve(m.id))).toBe("NOT_A_CONFIRMED_MATCH");
    });

    it("refuses another shop's match", async () => {
      const m = await setUp();
      const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
      expect(await refusal(approveRefund(db, fakePayPal().client, { shopId: other, sessionId: SESSION, matchId: m.id, now: NOW }))).toBe("NO_SUCH_MATCH");
    });

    it("refuses while an earlier refund for this line is not settled as failed", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      await execute(a.approvalId, fakePayPal({ refundSteps: ["down", "down", "down"] }).client);
      expect(await refusal(approve(m.id))).toBe("REFUND_ALREADY_IN_PROGRESS");
    });
  });

  describe("what is left on the payment, from PayPal", () => {
    // One payment of $100 with two lines on it: $30 and $60.
    async function twoLines() {
      const cipher = createContactCipher("k".repeat(32), shopId);
      await storeOrderLines(db, shopId, [line({ lineNo: 2, sku: "PAPA-2", unitPriceCents: 6000 })], cipher, "test");
      await setUp(line({ unitPriceCents: 3000 }), { amountCents: 10000 });
      const { rows } = await db.query<{ id: string; line_no: number }>(
        `select m.id, l.line_no from recall_matches m join recalls r using (recall_id) join order_lines l on l.id = m.order_line_id
         where m.shop_id = $1 and r.recall_number = '27027' order by l.line_no`,
        [shopId],
      );
      return { thirty: rows[0].id, sixty: rows[1].id };
    }
    const hundred = (over: Parameters<typeof fakePayPal>[0] = {}) => fakePayPal({ amountCents: 10000, ...over });

    it("counts a refund made in PayPal itself once one of ours can show the total", async () => {
      const { thirty, sixty } = await twoLines();
      const pp = hundred();
      await execute((await approve(thirty, SESSION, NOW, pp.client)).approvalId, pp.client);
      pp.refundElsewhere(2000); // $50 refunded in all, $50 left, and the $60 line no longer fits
      expect(await refusal(approve(sixty, SESSION, NOW, pp.client))).toBe("AMOUNT_ABOVE_REMAINING");
      expect(pp.posts()).toHaveLength(1);
    });

    it("says what is left and what the seller can do next", async () => {
      const { thirty, sixty } = await twoLines();
      const pp = hundred();
      await execute((await approve(thirty, SESSION, NOW, pp.client)).approvalId, pp.client);
      pp.refundElsewhere(2000);
      const message = await approve(sixty, SESSION, NOW, pp.client).catch((e: Error) => e.message);
      expect(message).toBe("This payment has 50.00 USD left to refund, and this line is 60.00 USD. To refund what is left, do it in PayPal.");
    });

    it("allows the second line when the balance covers it", async () => {
      const { thirty, sixty } = await twoLines();
      const pp = hundred();
      await execute((await approve(thirty, SESSION, NOW, pp.client)).approvalId, pp.client);
      const r = await execute((await approve(sixty, SESSION, NOW, pp.client)).approvalId, pp.client);
      expect(r.status).toBe("refunded");
      expect(pp.made()).toHaveLength(2);
    });

    it("checks again at the send: a refund made in PayPal after the approval stops it", async () => {
      const { thirty, sixty } = await twoLines();
      const pp = hundred();
      await execute((await approve(thirty, SESSION, NOW, pp.client)).approvalId, pp.client);
      const a = await approve(sixty, SESSION, NOW, pp.client);
      pp.refundElsewhere(2000);
      expect(await refusal(execute(a.approvalId, pp.client))).toBe("AMOUNT_ABOVE_REMAINING");
      expect(pp.posts()).toHaveLength(1);
      const { rows } = await db.query<{ consumed_at: unknown }>("select consumed_at from approvals where id = $1", [a.approvalId]);
      expect(rows[0].consumed_at).toBeNull();
    });

    it("counts money that may be on its way: a refund with no clear answer holds its share", async () => {
      const { thirty, sixty } = await twoLines();
      const pp = hundred({ refundSteps: ["down", "down", "down"] });
      await execute((await approve(sixty, SESSION, NOW, pp.client)).approvalId, pp.client);
      // PayPal shows nothing refunded, but the $60 may still land: only $40 can be promised.
      const fits = await approve(thirty, SESSION, NOW, pp.client);
      expect(fits.amountCents).toBe(3000);
      const more = await storeOrderLines(db, shopId, [line({ lineNo: 3, sku: "PAPA-3", unitPriceCents: 5000 })], createContactCipher("k".repeat(32), shopId), "test");
      expect(more.inserted).toBe(1);
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      const { rows } = await db.query<{ id: string }>(
        `select m.id from recall_matches m join recalls r using (recall_id) join order_lines l on l.id = m.order_line_id
         where m.shop_id = $1 and r.recall_number = '27027' and l.line_no = 3`,
        [shopId],
      );
      expect(await refusal(approve(rows[0].id, SESSION, NOW, pp.client))).toBe("AMOUNT_ABOVE_REMAINING");
    });

    it("refuses to guess when PayPal shows a partial refund and no refund of ours can show the total", async () => {
      const m = await setUp();
      expect(await refusal(approve(m.id, SESSION, NOW, fakePayPal({ status: "PARTIALLY_REFUNDED" }).client))).toBe("REMAINING_UNKNOWN");
    });

    it("refuses to guess when PayPal's refund does not state the total", async () => {
      const { thirty, sixty } = await twoLines();
      const pp = hundred();
      await execute((await approve(thirty, SESSION, NOW, pp.client)).approvalId, pp.client);
      const noTotal: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          const answer = await pp.client.request<Record<string, unknown>>(method, path, opts);
          if (path.includes("/refunds/")) delete answer.data.seller_payable_breakdown;
          return answer;
        }) as PayPalClient["request"],
      };
      expect(await refusal(approve(sixty, SESSION, NOW, noTotal))).toBe("REMAINING_UNKNOWN");
    });

    it("says PayPal did not answer rather than guessing, and approves nothing", async () => {
      const m = await setUp();
      expect(await refusal(approve(m.id, SESSION, NOW, fakePayPal({ captureReads: ["down", "down", "down"] }).client))).toBe("PAYPAL_UNREACHABLE");
      expect((await db.query("select 1 from approvals")).rows).toEqual([]);
    });

    it("refuses at the approval what the send would refuse", async () => {
      const m = await setUp();
      const client = (over: Parameters<typeof fakePayPal>[0]) => fakePayPal(over).client;
      expect(await refusal(approve(m.id, SESSION, NOW, client({ status: "REFUNDED" })))).toBe("NOTHING_LEFT_TO_REFUND");
      expect(await refusal(approve(m.id, SESSION, NOW, client({ status: "DECLINED" })))).toBe("PAYPAL_FACTS_CHANGED");
      expect(await refusal(approve(m.id, SESSION, NOW, client({ currency: "CAD" })))).toBe("PAYPAL_FACTS_CHANGED");
      expect(await refusal(approve(m.id, SESSION, NOW, client({ createTime: "2026-05-01T00:00:00Z" })))).toBe("REFUND_WINDOW_CLOSED");
      expect(await refusal(approve(m.id, SESSION, NOW, client({ createTime: "2026-10-15T12:00:00Z" })))).toBe("PAYMENT_NOT_AFTER_RECALL");
      expect(await refusal(approve(m.id, SESSION, NOW, client({ amountCents: 8000 })))).toBe("AMOUNT_ABOVE_REMAINING");
      expect((await db.query("select 1 from approvals")).rows).toEqual([]);
    });

    it("words the closed window the way the copy deck does", async () => {
      const m = await setUp();
      const message = await approve(m.id, SESSION, NOW, fakePayPal({ createTime: "2026-05-01T00:00:00Z" }).client).catch((e: Error) => e.message);
      expect(message).toBe("PayPal refund window closed. Check the recall page for the next steps.");
    });
  });

  describe("a refund with no clear answer leaves the seller one way forward at a time", () => {
    async function noAnswer() {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundSteps: ["down", "down", "down"] });
      const r = await execute(a.approvalId, pp.client);
      await agedFromNow(r.refundId);
      return { m, r, pp };
    }
    const SOON = new Date(NOW.getTime() + 7 * 60_000);
    const TOO_OLD = new Date(NOW.getTime() + 7 * 3_600_000);
    const read = (refundId: string, client: PayPalClient, now: Date) => reconcileRefund(db, client, { shopId, refundId, recordKey: key, now });
    const again = (refundId: string, client: PayPalClient, now: Date) => askPayPalAgain(db, client, { shopId, refundId, recordKey: key, now });

    it("offers asking PayPal again first, and does not yet tell the seller to refund it themselves", async () => {
      const { r, pp } = await noAnswer();
      expect(await read(r.refundId, pp.client, SOON)).toMatchObject({ canAskAgain: true, stuck: null });
    });

    it("turns to PayPal itself once the request is too old to repeat, naming the order", async () => {
      const { r, pp } = await noAnswer();
      expect(await read(r.refundId, pp.client, TOO_OLD)).toMatchObject({ canAskAgain: false, stuck: { orderNumber: "#R1", sentToPayPal: false } });
    });

    it("turns to PayPal itself once a repeat was refused, shows PayPal's answer, and repeats no more", async () => {
      const { r } = await noAnswer();
      await again(r.refundId, fakePayPal({ refundSteps: [422] }).client, SOON);
      const pp = fakePayPal();
      const rec = await read(r.refundId, pp.client, SOON);
      expect(rec).toMatchObject({ canAskAgain: false, stuck: { orderNumber: "#R1" } });
      expect(rec.exceptions).toContain("PayPal refused the repeat (REFUND_AMOUNT_EXCEEDED). Check PayPal directly before doing anything else.");
      expect(await refusal(again(r.refundId, pp.client, SOON))).toBe("CHECK_IN_PAYPAL");
      expect(pp.posts()).toEqual([]);
    });

    it("offers neither while a send may still be running: a refund made by hand now could be a second one", async () => {
      const { r, pp } = await noAnswer();
      await db.query("update refunds set send_lease_until = $2::timestamptz where id = $1", [r.refundId, new Date(SOON.getTime() + 60_000).toISOString()]);
      expect(await read(r.refundId, pp.client, SOON)).toMatchObject({ canAskAgain: false, stuck: null });
      expect(await refusal(sendSellerToPayPal(db, { shopId, refundId: r.refundId, now: SOON }))).toBe("REFUND_BEING_SENT");
    });

    it("records that the seller was sent to PayPal, once", async () => {
      const { r, pp } = await noAnswer();
      await sendSellerToPayPal(db, { shopId, refundId: r.refundId, now: TOO_OLD });
      await sendSellerToPayPal(db, { shopId, refundId: r.refundId, now: new Date(TOO_OLD.getTime() + 60_000) });
      expect((await read(r.refundId, pp.client, TOO_OLD)).stuck?.sentToPayPal).toBe(true);
      const { rows } = await db.query<{ seller_sent_to_paypal_at: Date }>("select seller_sent_to_paypal_at from refunds");
      expect(rows[0].seller_sent_to_paypal_at.getTime()).toBe(TOO_OLD.getTime());
    });

    it("never repeats once the seller was sent to PayPal: they may have refunded it there", async () => {
      const { r } = await noAnswer();
      await sendSellerToPayPal(db, { shopId, refundId: r.refundId, now: SOON });
      const pp = fakePayPal();
      expect((await read(r.refundId, pp.client, SOON)).canAskAgain).toBe(false);
      expect(await refusal(again(r.refundId, pp.client, SOON))).toBe("CHECK_IN_PAYPAL");
      expect(pp.posts()).toEqual([]);
    });

    it("holds that even if the seller is sent there while the repeat is getting ready", async () => {
      const { r } = await noAnswer();
      const pp = fakePayPal();
      const racing: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          if (method === "GET") await sendSellerToPayPal(db, { shopId, refundId: r.refundId, now: SOON });
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
      expect(await refusal(again(r.refundId, racing, SOON))).toBe("CHECK_IN_PAYPAL");
      expect(pp.posts()).toEqual([]);
    });

    it("holds when another repeat is refused while this one is getting ready", async () => {
      const { r } = await noAnswer();
      const pp = fakePayPal();
      const racing: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          if (method === "GET") await db.query("update refunds set repeat_refused_at = $2::timestamptz where id = $1", [r.refundId, SOON.toISOString()]);
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
      expect(await refusal(again(r.refundId, racing, SOON))).toBe("CHECK_IN_PAYPAL");
      expect(pp.posts()).toEqual([]);
    });

    it("stays with PayPal even if a late answer replaces the words on the row", async () => {
      const { r } = await noAnswer();
      await again(r.refundId, fakePayPal({ refundSteps: [422] }).client, SOON);
      await db.query("update refunds set failure = 'No clear answer from PayPal. Check it before trying again.' where id = $1", [r.refundId]);
      const pp = fakePayPal();
      expect(await read(r.refundId, pp.client, SOON)).toMatchObject({ canAskAgain: false, stuck: { orderNumber: "#R1" } });
      expect(await refusal(again(r.refundId, pp.client, SOON))).toBe("CHECK_IN_PAYPAL");
    });

    it("never frees the line: a new request id could refund the same sale twice", async () => {
      const { m, r } = await noAnswer();
      await sendSellerToPayPal(db, { shopId, refundId: r.refundId, now: SOON });
      expect(await refusal(approve(m.id))).toBe("REFUND_ALREADY_IN_PROGRESS");
    });

    it("is not offered once the refund has a clear answer", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      expect((await read(r.refundId, pp.client, NOW)).stuck).toBeNull();
      expect(await refusal(sendSellerToPayPal(db, { shopId, refundId: r.refundId, now: NOW }))).toBe("NOTHING_TO_ASK");
    });

    it("refuses another shop's refund", async () => {
      const { r } = await noAnswer();
      const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
      expect(await refusal(sendSellerToPayPal(db, { shopId: other, refundId: r.refundId, now: NOW }))).toBe("NO_SUCH_REFUND");
      expect(await refusal(sendSellerToPayPal(db, { shopId, refundId: "not-a-uuid", now: NOW }))).toBe("NO_SUCH_REFUND");
    });
  });

  describe("facts changing while the reservation is being made", () => {
    /** Runs `during` inside the transaction, just as the capture lock is taken. */
    const whileWaitingForTheLock = (during: (tx: { query: typeof db.query }) => Promise<unknown>): typeof db => ({
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            query: (async (sql: string, params?: unknown[]) => {
              const answer = await tx.query(sql, params);
              if (sql.includes("pg_advisory_xact_lock")) await during(tx);
              return answer;
            }) as typeof tx.query,
          }),
        ),
    });
    const run = (d: typeof db, approvalId: string, client: PayPalClient) => executeRefund(d, client, { shopId, sessionId: SESSION, approvalId, recordKey: key, now: NOW });

    it("sees a line corrected while it waited for the capture lock", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const d = whileWaitingForTheLock((tx) => tx.query("update order_lines set unit_price_cents = 1000 where shop_id = $1", [shopId]));
      expect(await refusal(run(d, a.approvalId, pp.client))).toBe("LINE_CHANGED");
      expect(pp.posts()).toEqual([]);
    });

    it("sees a recall changed while it waited for the capture lock", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const d = whileWaitingForTheLock((tx) => tx.query("update recalls set raw_sha256 = 'changed' where recall_number = '27027'"));
      expect(await refusal(run(d, a.approvalId, pp.client))).toBe("RECALL_CHANGED");
      expect(pp.posts()).toEqual([]);
    });

    it("holds the line and the recall still until the reservation commits", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const seen: string[] = [];
      const d: typeof db = {
        ...db,
        transaction: (fn) =>
          db.transaction((tx) =>
            fn({
              ...tx,
              query: ((sql: string, params?: unknown[]) => {
                seen.push(sql);
                return tx.query(sql, params);
              }) as typeof tx.query,
            }),
          ),
      };
      await run(d, a.approvalId, fakePayPal().client);
      const lockedReads = seen.filter((q) => /for share/i.test(q));
      expect(lockedReads.some((q) => /from order_lines/.test(q))).toBe(true);
      expect(lockedReads.some((q) => /from recalls/.test(q))).toBe(true);
      expect(lockedReads.some((q) => /from paypal_payments/.test(q))).toBe(true);
      expect(seen.findIndex((q) => q.includes("pg_advisory_xact_lock"))).toBeLessThan(seen.findIndex((q) => /for share/i.test(q)));
    });
  });

  describe("before anything is sent", () => {
    /** Wraps the database so something happens right after the reservation commits. */
    const afterReserving = (then: () => Promise<void>): typeof db => ({
      ...db,
      transaction: async (fn) => {
        const out = await db.transaction(fn);
        await then();
        return out;
      },
    });
    const crash = async () => {
      throw new Error("the process died here");
    };
    const statusOf = async () => (await db.query<{ status: string; failure: string | null }>("select status, failure from refunds")).rows[0];

    it("says the outcome is unknown before the request leaves, so a crash mid-send cannot read as not sent", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const seen: string[] = [];
      const watching: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          if (method === "POST") seen.push((await statusOf()).status);
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
      await execute(a.approvalId, watching);
      expect(seen).toEqual(["unconfirmed"]);
    });

    it("says which match a refund belongs to, so its page can lead back to that card", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      await expect(executeRefund(afterReserving(crash), pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW })).rejects.toThrow();
      const { rows } = await db.query<{ id: string }>("select id from refunds");
      const rec = await readRefund(db, pp.client, { shopId, refundId: rows[0].id, recordKey: key, now: NOW });
      expect(rec.matchId).toBe(m.id);
    });

    it("frees the line when a reservation was never sent and its lease has run out", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      await expect(executeRefund(afterReserving(crash), pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW })).rejects.toThrow("died");
      expect((await statusOf()).status).toBe("reserved");
      expect(pp.posts()).toEqual([]);
      const { rows } = await db.query<{ id: string }>("select id from refunds");
      const later = new Date(NOW.getTime() + 7 * 60_000);
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: rows[0].id, recordKey: key, now: later });
      expect(rec.ledger.status).toBe("failed");
      expect((await statusOf()).failure).toBe("Never sent to PayPal.");
      await expect(approve(m.id, SESSION, later, pp.client)).resolves.toBeDefined();
    });

    it("leaves a reservation alone while its lease is running: the send may be about to happen", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      await expect(executeRefund(afterReserving(crash), pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW })).rejects.toThrow();
      const { rows } = await db.query<{ id: string }>("select id from refunds");
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: rows[0].id, recordKey: key, now: new Date(NOW.getTime() + 60_000) });
      expect(rec.ledger.status).toBe("reserved");
      expect(await refusal(askPayPalAgain(db, pp.client, { shopId, refundId: rows[0].id, recordKey: key, now: new Date(NOW.getTime() + 60_000) }))).toBe("REFUND_BEING_SENT");
    });

    it("sends nothing if the reservation was given up before the send began", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const givenUp = afterReserving(async () => {
        await db.query("update refunds set status = 'failed', failure = 'Never sent to PayPal.', send_lease_until = null, send_lease_id = null");
      });
      const r = await executeRefund(givenUp, pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW });
      expect(r.status).toBe("failed");
      expect(pp.posts()).toEqual([]);
    });

    it("a send past its lease does not go out: giving up on it may already be allowed", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const lapsed = afterReserving(async () => {
        await db.query("update refunds set send_lease_until = $1::timestamptz", [new Date(NOW.getTime() - 1000).toISOString()]);
      });
      const r = await executeRefund(lapsed, pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW });
      expect(r.status).toBe("reserved");
      expect(pp.posts()).toEqual([]);
    });

    it("does not begin a send too close to the end of its lease to finish inside it", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const nearlyOver = afterReserving(async () => {
        await db.query("update refunds set send_lease_until = $1::timestamptz", [new Date(NOW.getTime() + 60_000).toISOString()]);
      });
      const r = await executeRefund(nearlyOver, pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW });
      expect(r.status).toBe("reserved");
      expect(pp.posts()).toEqual([]);
    });

    it("does not send after a pause while it was marking the row, however long that pause was", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const start = Date.now();
      const pausing: typeof db = {
        ...db,
        query: (async (sql: string, params?: unknown[]) => {
          const answer = await db.query(sql, params);
          if (sql.includes("set status = 'unconfirmed'")) vi.spyOn(Date, "now").mockReturnValue(start + 7 * 60_000);
          return answer;
        }) as typeof db.query,
      };
      await executeRefund(pausing, pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW });
      vi.restoreAllMocks();
      expect(pp.posts()).toEqual([]);
    });

    it("gives the send a last moment to begin, early enough to finish before its lease ends", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      let notAfter: number | undefined;
      const watching: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          if (method === "POST") notAfter = opts?.notAfter;
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
      const before = Date.now();
      await execute(a.approvalId, watching);
      // 6 minutes of lease, less 90 seconds: the slowest single attempt, with its token request.
      expect(notAfter).toBeGreaterThanOrEqual(before + 4.4 * 60_000);
      expect(notAfter).toBeLessThanOrEqual(Date.now() + 4.6 * 60_000);
    });

    it("giving up cannot overwrite a send that began while it was deciding", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      await expect(executeRefund(afterReserving(crash), pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW })).rejects.toThrow();
      const { rows } = await db.query<{ id: string }>("select id from refunds");
      // The reader sees reserved and an expired lease, then a send moves the row before it writes.
      const racing: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          await db.query("update refunds set status = 'unconfirmed' where id = $1", [rows[0].id]);
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
      const later = new Date(NOW.getTime() + 7 * 60_000);
      const rec = await reconcileRefund(db, racing, { shopId, refundId: rows[0].id, recordKey: key, now: later });
      expect(rec.ledger.status).toBe("unconfirmed");
      expect(await refusal(approve(m.id, SESSION, later, pp.client))).toBe("REFUND_ALREADY_IN_PROGRESS");
    });

    it("giving up cannot overwrite a reservation whose lease was renewed", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      await expect(executeRefund(afterReserving(crash), pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW })).rejects.toThrow();
      const { rows } = await db.query<{ id: string }>("select id from refunds");
      const later = new Date(NOW.getTime() + 7 * 60_000);
      const renewing: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          await db.query("update refunds set send_lease_until = $2::timestamptz where id = $1", [rows[0].id, new Date(later.getTime() + 60_000).toISOString()]);
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
      const rec = await reconcileRefund(db, renewing, { shopId, refundId: rows[0].id, recordKey: key, now: later });
      expect(rec.ledger.status).toBe("reserved");
    });

    it("counts a reservation against the payment's balance", async () => {
      const m = await setUp(line({ unitPriceCents: 6000 }), { amountCents: 10000 });
      const a = await approve(m.id);
      const pp = fakePayPal({ amountCents: 10000 });
      await expect(executeRefund(afterReserving(crash), pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW })).rejects.toThrow();
      await storeOrderLines(db, shopId, [line({ lineNo: 2, sku: "PAPA-2", unitPriceCents: 5000 })], createContactCipher("k".repeat(32), shopId), "test");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      const { rows } = await db.query<{ id: string }>(
        `select m.id from recall_matches m join recalls r using (recall_id) join order_lines l on l.id = m.order_line_id
         where m.shop_id = $1 and r.recall_number = '27027' and l.line_no = 2`,
        [shopId],
      );
      expect(await refusal(approve(rows[0].id, SESSION, NOW, pp.client))).toBe("AMOUNT_ABOVE_REMAINING");
    });
  });

  describe("deadlines are checked when they matter, not when the request came in", () => {
    /** A client whose capture read takes this long, measured on the clock the refund code reads. */
    function slowCaptureRead(pp: ReturnType<typeof fakePayPal>, tookMs: number): PayPalClient {
      const real = performance.now.bind(performance);
      return {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          if (method === "GET" && /captures\/[^/]+$/.test(path)) {
            const later = real() + tookMs;
            vi.spyOn(performance, "now").mockImplementation(() => later);
          }
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
    }
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("refuses an approval that ran out while PayPal was being read", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const almostOver = new Date(NOW.getTime() + 14 * 60_000 + 59_000);
      expect(await refusal(execute(a.approvalId, slowCaptureRead(pp, 30_000), SESSION, almostOver))).toBe("APPROVAL_NOT_VALID");
      expect(pp.posts()).toEqual([]);
    });

    it("refuses a repeat whose whole send would not fit before the six-hour limit", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const first = fakePayPal({ refundSteps: ["down", "down", "down"] });
      const r = await execute(a.approvalId, first.client);
      await agedFromNow(r.refundId);
      const pp = fakePayPal();
      const nearLimit = new Date(NOW.getTime() + 6 * 3_600_000 - 7 * 60_000);
      const rejected = askPayPalAgain(db, slowCaptureRead(pp, 2 * 60_000), { shopId, refundId: r.refundId, recordKey: key, now: nearLimit });
      expect(await refusal(rejected)).toBe("TOO_OLD_TO_ASK_AGAIN");
      expect(pp.posts()).toEqual([]);
    });

    it("still repeats when the whole send fits before the limit", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const first = fakePayPal({ refundSteps: ["down", "down", "down"] });
      const r = await execute(a.approvalId, first.client);
      await agedFromNow(r.refundId);
      const pp = fakePayPal();
      const fine = new Date(NOW.getTime() + 60 * 60_000);
      expect((await askPayPalAgain(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: fine })).status).toBe("refunded");
    });
  });

  describe("a dispute on the payment", () => {
    const disputeCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/v1/customer/disputes"));

    it("reads PayPal's disputes for this capture at review and again before sending", async () => {
      const { id: matchId } = await setUp();
      const pp = fakePayPal();
      const approval = await approve(matchId, SESSION, NOW, pp.client);
      expect(disputeCalls(pp.calls)).toHaveLength(1);
      await execute(approval.approvalId, pp.client);
      expect(disputeCalls(pp.calls)).toHaveLength(2);
      expect(disputeCalls(pp.calls)[0].path).toBe("/v1/customer/disputes");
    });

    it("won't offer a refund on a payment with an open dispute", async () => {
      const { id: matchId } = await setUp();
      expect(await refusal(approve(matchId, SESSION, NOW, fakePayPal({ disputes: [{ status: "OPEN" }] }).client))).toBe("PAYMENT_DISPUTED");
      expect((await db.query("select 1 from approvals")).rows).toEqual([]);
    });

    it("sends nothing if a dispute opens after the approval, and leaves the approval unspent", async () => {
      const { id: matchId } = await setUp();
      const { approvalId } = await approve(matchId, SESSION, NOW, fakePayPal().client);
      const disputed = fakePayPal({ disputes: [{ status: "WAITING_FOR_SELLER_RESPONSE" }] });
      expect(await refusal(execute(approvalId, disputed.client))).toBe("PAYMENT_DISPUTED");
      expect(disputed.calls.filter((c) => c.method === "POST")).toEqual([]);
      expect((await db.query<{ consumed_at: unknown }>("select consumed_at from approvals where id = $1", [approvalId])).rows[0].consumed_at).toBeNull();
      expect((await db.query("select 1 from refunds")).rows).toEqual([]);
      await expect(execute(approvalId, fakePayPal().client)).resolves.toMatchObject({ status: "refunded" });
    });

    it("holds the refund if the disputes can't be read, says so, and lets it be tried again", async () => {
      const { id: matchId } = await setUp();
      const { approvalId } = await approve(matchId, SESSION, NOW, fakePayPal().client);
      const down = fakePayPal({ disputes: "down" });
      await expect(execute(approvalId, down.client)).rejects.toMatchObject({ code: "DISPUTES_UNREADABLE", message: "PayPal's disputes could not be read, so nothing was refunded. Please try again." });
      expect(down.calls.filter((c) => c.method === "POST")).toEqual([]);
      await expect(execute(approvalId, fakePayPal().client)).resolves.toMatchObject({ status: "refunded" });
    });

    it("sends the seller to PayPal on a resolved dispute too, since the buyer may already be paid back", async () => {
      const { id: matchId } = await setUp();
      expect(await refusal(approve(matchId, SESSION, NOW, fakePayPal({ disputes: [{ status: "RESOLVED" }] }).client))).toBe("PAYMENT_DISPUTED");
    });

    it("stores nothing from the dispute", async () => {
      const { id: matchId } = await setUp();
      await refusal(approve(matchId, SESSION, NOW, fakePayPal({ disputes: [{ status: "OPEN", reason: "SENTINEL" } as { status: string }] }).client));
      const { rows } = await db.query<{ t: string; c: string }>("select table_name as t, column_name as c from information_schema.columns where table_schema = 'public' and data_type in ('text', 'jsonb')");
      for (const { t, c } of rows) expect((await db.query(`select 1 from "${t}" where "${c}"::text like '%SENTINEL%' limit 1`)).rows, `${t}.${c}`).toEqual([]);
    });
  });

  describe("the payment's date", () => {
    const LATE = new Date("2027-04-14T15:00:00Z");
    const tryAt = async (createTime: string, now = LATE) => {
      const m = await setUp();
      const pp = fakePayPal({ createTime });
      const a = await approve(m.id, SESSION, now, pp.client);
      return execute(a.approvalId, pp.client, SESSION, now);
    };

    it("counts 180 days from the moment of payment: 179 days and 15.5 hours is still inside", async () => {
      expect((await tryAt("2026-10-16T23:30:00Z")).status).toBe("refunded");
    });

    it("closes once 180 days have truly passed", async () => {
      expect(await refusal(tryAt("2026-10-16T14:00:00Z"))).toBe("REFUND_WINDOW_CLOSED");
    });

    it("reads a time zone offset rather than dropping it", async () => {
      // 23:30 at -07:00 on the recall's date is already 02:30 the next day in New York.
      expect((await tryAt("2026-10-15T23:30:00-07:00", NOW)).status).toBe("refunded");
    });

    it("counts a payment late on the recall's own US date as that date, though UTC has moved on", async () => {
      // 03:30 UTC on Oct 16 is 23:30 on Oct 15 in New York, the recall's date, so it is not after the recall.
      expect(await refusal(tryAt("2026-10-16T03:30:00Z", NOW))).toBe("PAYMENT_NOT_AFTER_RECALL");
    });

    it("refuses a date it cannot read: nothing moves on a guess", async () => {
      expect(await refusal(tryAt("not a date", NOW))).toBe("PAYPAL_FACTS_CHANGED");
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
      expect(post?.opts.body).toEqual({ amount: { currency_code: "USD", value: "52.50" }, note_to_payer: REFUND_NOTE });
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
        ["whether the whole order could be read", { orderIncomplete: true }],
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
        expect(pp.posts()[0].opts.body).toEqual({ amount: { currency_code: "USD", value: "30.00" }, note_to_payer: REFUND_NOTE });
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

    it("asks again with the same note as the first send", async () => {
      const { r, pp } = await noClearAnswer(["lost", "lost", "lost"]);
      const repeat = fakePayPal();
      await again(r.refundId, repeat.client, LATER);
      expect(pp.posts()[0].opts.body).toMatchObject({ note_to_payer: REFUND_NOTE });
      expect(repeat.posts()[0].opts.body).toEqual(pp.posts()[0].opts.body);
    });

    it("reads PayPal's disputes before asking again, since the repeat may be the real first refund", async () => {
      const { r } = await noClearAnswer(["lost", "lost", "lost"]);
      const disputed = fakePayPal({ disputes: [{ status: "OPEN" }] });
      expect(await refusal(again(r.refundId, disputed.client, LATER))).toBe("PAYMENT_DISPUTED");
      expect(disputed.posts()).toEqual([]);
    });

    it("sends nothing again if the disputes can't be read", async () => {
      const { r } = await noClearAnswer(["lost", "lost", "lost"]);
      const down = fakePayPal({ disputes: "down" });
      const refused = await again(r.refundId, down.client, LATER).catch((err: RefundRefused) => err);
      expect(refused).toBeInstanceOf(RefundRefused);
      expect((refused as RefundRefused).code).toBe("DISPUTES_UNREADABLE");
      expect(down.posts()).toEqual([]);
    });

    it("doesn't say nothing was refunded when the first request may have landed", async () => {
      const { r } = await noClearAnswer(["lost", "lost", "lost"]);
      const refused = await again(r.refundId, fakePayPal({ disputes: "down" }).client, LATER).catch((err: RefundRefused) => err);
      expect((refused as RefundRefused).message).not.toMatch(/nothing was refunded/i);
      expect((refused as RefundRefused).message).toMatch(/wasn't sent again/);
    });

    it("once a dispute shows it offers no more repeats, and never tells the owner to refund by hand", async () => {
      const { r } = await noClearAnswer(["lost", "lost", "lost"]);
      const disputed = fakePayPal({ disputes: [{ status: "OPEN" }] });
      expect(await refusal(again(r.refundId, disputed.client, LATER))).toBe("PAYMENT_DISPUTED");
      const after = await readRefund(db, disputed.client, { shopId, refundId: r.refundId, recordKey: key, now: LATER });
      expect(after.canAskAgain).toBe(false);
      expect(after.stuck).toMatchObject({ disputed: true });
      const later = fakePayPal();
      expect(await refusal(again(r.refundId, later.client, LATER))).toBe("PAYMENT_DISPUTED");
      expect(later.calls).toEqual([]);
    });

    it("while another send holds the lease it refuses first, and reads nothing from PayPal", async () => {
      const { r } = await noClearAnswer(["lost", "lost", "lost"]);
      await db.query("update refunds set send_lease_until = $2::timestamptz where id = $1", [r.refundId, new Date(LATER.getTime() + 60_000).toISOString()]);
      const pp = fakePayPal({ disputes: [{ status: "OPEN" }] });
      expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("REFUND_BEING_SENT");
      expect(pp.calls).toEqual([]);
      expect((await db.query<{ dispute_seen_at: Date | null }>("select dispute_seen_at from refunds where id = $1", [r.refundId])).rows[0].dispute_seen_at).toBeNull();
    });

    it("sends nothing if another request saw a dispute while this one was still checking", async () => {
      const { r } = await noClearAnswer(["lost", "lost", "lost"]);
      const pp = fakePayPal();
      const beaten: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          const answer = await pp.client.request(method, path, opts);
          if (path.startsWith("/v1/customer/disputes")) await db.query("update refunds set dispute_seen_at = $2::timestamptz where id = $1", [r.refundId, LATER.toISOString()]);
          return answer;
        }) as PayPalClient["request"],
      };
      expect(await refusal(again(r.refundId, beaten, LATER))).toBe("PAYMENT_DISPUTED");
      expect(pp.posts()).toEqual([]);
    });

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

    describe("a refused repeat", () => {
      // "Failed" frees the line for a new request id, and a capture can still read COMPLETED while a
      // refund settles, so no refusal of a repeat is proof that the earlier send made nothing.
      const refusals: [number, RefundStep[]][] = [
        [400, [400]],
        [401, [401, 401]],
        [403, [403]],
        [404, [404]],
        [422, [422]],
      ];
      it.each(refusals)("stays unconfirmed on %s and keeps the line blocked", async (_status, steps) => {
        const { m, r } = await noClearAnswer(["down", "down", "down"]);
        const after = await again(r.refundId, fakePayPal({ refundSteps: steps }).client, LATER);
        expect(after.status).toBe("unconfirmed");
        expect(await refusal(approve(m.id))).toBe("REFUND_ALREADY_IN_PROGRESS");
      });

      it("tells the seller what PayPal said and where to look next", async () => {
        const { r } = await noClearAnswer(["down", "down", "down"]);
        const after = await again(r.refundId, fakePayPal({ refundSteps: [422] }).client, LATER);
        expect(after.failure).toBe("PayPal refused the repeat (REFUND_AMOUNT_EXCEEDED). Check PayPal directly before doing anything else.");
      });

      it("makes no extra call to PayPal after the refusal", async () => {
        const { r } = await noClearAnswer(["down", "down", "down"]);
        const pp = fakePayPal({ refundSteps: [422] });
        await again(r.refundId, pp.client, LATER);
        expect(pp.calls.at(-1)?.method).toBe("POST");
      });

      it("counts as failed only when PayPal reports this very refund as failed", async () => {
        const { m, r } = await noClearAnswer(["down", "down", "down"]);
        const after = await again(r.refundId, fakePayPal({ refundStatus: "FAILED" }).client, LATER);
        expect(after.status).toBe("failed");
        await expect(approve(m.id)).resolves.toBeDefined();
      });
    });

    describe("the same checks as the first send", () => {
      it("refuses when the join no longer points at this payment", async () => {
        const { r } = await noClearAnswer(["down", "down", "down"]);
        await db.query(
          `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency)
           values ($1, 'ORDER-2', 'r1', 'CAP-2', 'COMPLETED', '2026-11-06T14:00:00Z', 10000, 'USD')`,
          [shopId],
        );
        const pp = fakePayPal();
        expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("PAYMENT_CHANGED");
        expect(pp.posts()).toEqual([]);
      });

      it("refuses past 180 days from the payment", async () => {
        const { r } = await noClearAnswer(["down", "down", "down"]);
        const pp = fakePayPal({ createTime: "2026-05-01T00:00:00Z" });
        expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("REFUND_WINDOW_CLOSED");
        expect(pp.posts()).toEqual([]);
      });

      it("refuses a currency that differs from the approved one", async () => {
        const { r } = await noClearAnswer(["down", "down", "down"]);
        const pp = fakePayPal({ currency: "CAD" });
        expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("PAYPAL_FACTS_CHANGED");
        expect(pp.posts()).toEqual([]);
      });

      it("refuses a capture status that does not allow a refund", async () => {
        const { r } = await noClearAnswer(["down", "down", "down"]);
        const pp = fakePayPal({ status: "DECLINED" });
        expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("PAYPAL_FACTS_CHANGED");
        expect(pp.posts()).toEqual([]);
      });

      it("takes no lease and sends nothing when the capture cannot be read", async () => {
        const { r } = await noClearAnswer(["down", "down", "down"]);
        const pp = fakePayPal({ captureReads: ["down", "down", "down"] });
        expect(await refusal(again(r.refundId, pp.client, LATER))).toBe("PAYPAL_UNREACHABLE");
        expect(pp.posts()).toEqual([]);
        const { rows } = await db.query<{ send_lease_until: unknown }>("select send_lease_until from refunds where id = $1", [r.refundId]);
        expect(rows[0].send_lease_until).toBeNull();
      });
    });

    it("a send that lost its lease cannot settle the row over the send that took it over", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const first = heldBack(fakePayPal({ refundSteps: [422] }).client, (method) => method === "POST");
      const sending = execute(a.approvalId, first.client);
      await first.reached;
      const { rows } = await db.query<{ id: string }>("select id from refunds");
      await db.query("update refunds set status = 'unconfirmed', send_lease_until = $2::timestamptz where id = $1", [rows[0].id, NOW.toISOString()]);
      await agedFromNow(rows[0].id);
      const pp = fakePayPal();
      const second = heldBack(pp.client, (method) => method === "POST");
      const asking = again(rows[0].id, second.client, LATER);
      await second.reached;
      first.release();
      expect((await sending).status).toBe("unconfirmed"); // its 422 does not free the line
      second.release();
      expect((await asking).status).toBe("refunded");
      expect(pp.made()).toHaveLength(1);
    });

    it("starts the lease when it is taken, not when the request came in", async () => {
      const { r } = await noClearAnswer(["down", "down", "down"]);
      const pp = fakePayPal();
      const leases: Date[] = [];
      const slowRead: PayPalClient = {
        request: (async (method: "GET" | "POST" | "PATCH", path: string, opts?: Parameters<PayPalClient["request"]>[2]) => {
          if (method === "GET") await new Promise((resolve) => setTimeout(resolve, 60));
          if (method === "POST") {
            const { rows } = await db.query<{ send_lease_until: Date }>("select send_lease_until from refunds");
            leases.push(rows[0].send_lease_until);
          }
          return pp.client.request(method, path, opts);
        }) as PayPalClient["request"],
      };
      await again(r.refundId, slowRead, LATER);
      expect(leases[0].getTime() - LATER.getTime()).toBeGreaterThanOrEqual(6 * 60_000 + 50);
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

  describe("reading a refund, which is what opening the page does", () => {
    const stored = async (id: string) => (await db.query<{ status: string; updated_at: Date }>("select status, updated_at from refunds where id = $1", [id])).rows[0];

    it("changes nothing, and says PayPal has a newer answer", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundStatus: "PENDING" });
      const r = await execute(a.approvalId, pp.client);
      pp.settle("COMPLETED");
      const before = await stored(r.refundId);
      const read = await readRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(read.ledger.status).toBe("pending");
      expect(read.newerAnswer).toBe("refunded");
      expect(read.exceptions).toContain("PayPal's answer is newer than our ledger. Update it below.");
      expect(await stored(r.refundId)).toEqual(before);
    });

    it("the update is a separate, deliberate step", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundStatus: "PENDING" });
      const r = await execute(a.approvalId, pp.client);
      pp.settle("COMPLETED");
      const updated = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(updated.ledger.status).toBe("refunded");
      expect(updated.newerAnswer).toBeNull();
      expect((await stored(r.refundId)).status).toBe("refunded");
    });

    it("does not give up on a reservation just because someone looked", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const dies: typeof db = {
        ...db,
        transaction: async (fn) => {
          const out = await db.transaction(fn);
          throw Object.assign(new Error("the process died here"), { out });
        },
      };
      await expect(executeRefund(dies, pp.client, { shopId, sessionId: SESSION, approvalId: a.approvalId, recordKey: key, now: NOW })).rejects.toThrow("died");
      const { rows } = await db.query<{ id: string }>("select id from refunds");
      const later = new Date(NOW.getTime() + 7 * 60_000);
      const read = await readRefund(db, pp.client, { shopId, refundId: rows[0].id, recordKey: key, now: later });
      expect(read.ledger.status).toBe("reserved");
      expect(read.newerAnswer).toBe("failed");
      expect((await stored(rows[0].id)).status).toBe("reserved");
    });

    it("has nothing newer to say when the row already agrees with PayPal", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      expect((await readRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW })).newerAnswer).toBeNull();
    });
  });

  describe("reconciling", () => {
    const refundEvent = (e: { status: string; cents: number; check: "SUCCESS" | "FAILURE" | "UNAVAILABLE" | null; receivedAt?: Date }) =>
      db.query(
        `insert into paypal_webhook_events (event_id_hmac, event_type, resource_type, resource_id_hmac, verification_method, resource_status, resource_amount_cents, resource_currency, paypal_check, received_at)
         values ('e', 'PAYMENT.CAPTURE.REFUNDED', 'refund', $1, 'self', $2, $3, 'USD', $4, $5)`,
        [key("paypal-resource", "REF-1"), e.status, e.cents, e.check, (e.receivedAt ?? NOW).toISOString()],
      );
    it("shows capture, refund, webhook and ledger side by side, with no exceptions when they agree", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      await refundEvent({ status: "COMPLETED", cents: 9000, check: "SUCCESS" });
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(rec).toEqual({
        matchId: m.id,
        canAskAgain: false,
        stuck: null,
        newerAnswer: null,
        ledger: { status: "refunded", amountCents: 9000, currency: "USD" },
        capture: { status: "REFUNDED", amountCents: 9000, currency: "USD" },
        refund: { status: "COMPLETED", amountCents: 9000, currency: "USD" },
        webhook: { seen: true, paypalCheck: "SUCCESS", event: { status: "COMPLETED", amountCents: 9000, currency: "USD" } },
        exceptions: [],
      });
    });

    it("names the exception when no webhook has arrived", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal();
      const r = await execute(a.approvalId, pp.client);
      const rec = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(rec.webhook).toEqual({ seen: false, paypalCheck: null, event: null });
      expect(rec.exceptions).toEqual(["PayPal's webhook has not arrived yet."]);
    });

    describe("the refund event and PayPal's own check", () => {
      const refunded = async () => {
        const m = await setUp();
        const a = await approve(m.id);
        const pp = fakePayPal();
        const r = await execute(a.approvalId, pp.client);
        return () => reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      };

      it("names an event whose amount isn't the refund's", async () => {
        const read = await refunded();
        await refundEvent({ status: "COMPLETED", cents: 8000, check: "SUCCESS" });
        expect((await read()).exceptions).toEqual(["PayPal's refund event gives another amount than PayPal's refund."]);
      });

      it("names an event whose status isn't the refund's", async () => {
        const read = await refunded();
        await refundEvent({ status: "PENDING", cents: 9000, check: "SUCCESS" });
        expect((await read()).exceptions).toEqual(["PayPal's refund event says PENDING, and PayPal's refund reads COMPLETED."]);
      });

      it("names a FAILURE from PayPal's own check, though our check let the delivery in", async () => {
        const read = await refunded();
        await refundEvent({ status: "COMPLETED", cents: 9000, check: "FAILURE" });
        expect((await read()).exceptions).toEqual(["PayPal's own check didn't confirm this webhook. Our check did, so it was kept."]);
      });

      it("shows PayPal couldn't be asked without calling it a pass or an exception", async () => {
        const read = await refunded();
        await refundEvent({ status: "COMPLETED", cents: 9000, check: "UNAVAILABLE" });
        const rec = await read();
        expect(rec.webhook.paypalCheck).toBe("UNAVAILABLE");
        expect(rec.exceptions).toEqual([]);
      });

      it("says it's still asking PayPal for a minute, then that PayPal couldn't be asked", async () => {
        const read = await refunded();
        await refundEvent({ status: "COMPLETED", cents: 9000, check: null, receivedAt: new Date(NOW.getTime() - 20_000) });
        expect((await read()).webhook.paypalCheck).toBe("ASKING");
        await db.query("update paypal_webhook_events set received_at = $1", [new Date(NOW.getTime() - 120_000).toISOString()]);
        expect((await read()).webhook.paypalCheck).toBe("UNAVAILABLE");
      });
    });

    it("says PayPal hasn't finished a refund PayPal says is pending, and doesn't blame the webhook", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundStatus: "PENDING" });
      const r = await execute(a.approvalId, pp.client);
      const rec = await readRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(rec.exceptions).toEqual(["PayPal hasn't finished this refund yet."]);
    });

    it("goes back to waiting on the webhook once PayPal has finished", async () => {
      const m = await setUp();
      const a = await approve(m.id);
      const pp = fakePayPal({ refundStatus: "PENDING" });
      const r = await execute(a.approvalId, pp.client);
      pp.settle("COMPLETED");
      const rec = await readRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: NOW });
      expect(rec.exceptions).toEqual(["PayPal's answer is newer than our ledger. Update it below.", "PayPal's webhook has not arrived yet."]);
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

    describe("an older answer arriving after a newer one", () => {
      const statusOf = async (id: string) => (await db.query<{ status: string }>("select status from refunds where id = $1", [id])).rows[0].status;

      it("cannot move a refunded row back, and the reader sees the row as it stands", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        const pp = fakePayPal({ refundStatus: "PENDING" });
        const r = await execute(a.approvalId, pp.client);
        await agedFromNow(r.refundId);
        const later = new Date(NOW.getTime() + 11 * 60_000);
        // This reader gets PayPal's PENDING now, and its answer lands after the refund has completed.
        const slow = heldBack(pp.client, (method, path) => method === "GET" && path.includes("/refunds/"));
        const stale = reconcileRefund(db, slow.client, { shopId, refundId: r.refundId, recordKey: key, now: later });
        await slow.reached;
        pp.settle("COMPLETED");
        const fresh = await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: later });
        expect(fresh.ledger.status).toBe("refunded");
        slow.release();
        expect((await stale).ledger.status).toBe("refunded");
        expect(await statusOf(r.refundId)).toBe("refunded");
      });

      it("cannot revive a refund that failed", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        const pp = fakePayPal({ refundStatus: "PENDING" });
        const r = await execute(a.approvalId, pp.client);
        await agedFromNow(r.refundId);
        const later = new Date(NOW.getTime() + 11 * 60_000);
        const slow = heldBack(pp.client, (method, path) => method === "GET" && path.includes("/refunds/"));
        const stale = reconcileRefund(db, slow.client, { shopId, refundId: r.refundId, recordKey: key, now: later });
        await slow.reached;
        pp.settle("FAILED");
        await reconcileRefund(db, pp.client, { shopId, refundId: r.refundId, recordKey: key, now: later });
        slow.release();
        expect((await stale).ledger.status).toBe("failed");
        expect(await statusOf(r.refundId)).toBe("failed");
      });

      it("a send's late answer leaves a settled row alone and reports it as it stands", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        const slow = heldBack(fakePayPal({ refundSteps: ["down", "down", "down"] }).client, (method) => method === "POST");
        const sending = execute(a.approvalId, slow.client);
        await slow.reached;
        const { rows } = await db.query<{ id: string }>("select id from refunds");
        await db.query("update refunds set status = 'refunded' where id = $1", [rows[0].id]);
        slow.release();
        expect((await sending).status).toBe("refunded");
        expect(await statusOf(rows[0].id)).toBe("refunded");
      });

      it("still records PayPal's refund id from a late answer", async () => {
        const m = await setUp();
        const a = await approve(m.id);
        const pp = fakePayPal();
        const slow = heldBack(pp.client, (method) => method === "POST");
        const sending = execute(a.approvalId, slow.client);
        await slow.reached;
        const { rows } = await db.query<{ id: string }>("select id from refunds");
        await db.query("update refunds set status = 'refunded' where id = $1", [rows[0].id]);
        slow.release();
        await sending;
        const held = await db.query<{ refund_ref_hmac: string; refund_id: string }>(
          "select f.refund_ref_hmac, p.refund_id from refunds f join paypal_refund_refs p on p.refund_row_id = f.id",
        );
        expect(held.rows[0]).toEqual({ refund_ref_hmac: key("paypal-resource", "REF-1"), refund_id: "REF-1" });
      });
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

describe("every refusal says what the owner can do next", () => {
  const source = readFileSync(new URL("./refunds.ts", import.meta.url), "utf8");
  const refusals = [...source.matchAll(/new RefundRefused\(\s*"([A-Z_]+)",\s*(`[^`]*`|"[^"]*")/g)].map((m) => ({ code: m[1], message: m[2].slice(1, -1) }));
  const NEXT_STEP = /\b(review it again|read it from paypal|go back to your queue|send the (notice|check request)|check (it against |it in paypal|the |this |paypal|the sale)|to refund|press review refund|try again|fix the file|open it from|recall page)/i;

  it("finds them all", () => {
    const declared = /export type RefusalCode =([^;]+);/.exec(source)?.[1].match(/"([A-Z_]+)"/g)?.map((c) => c.slice(1, -1)) ?? [];
    expect(declared.length).toBeGreaterThan(15);
    expect(refusals.length).toBeGreaterThan(25);
    for (const code of new Set(refusals.map((r) => r.code))) expect(declared).toContain(code);
  });

  it("has a next step in each", () => {
    expect(refusals.filter((r) => !NEXT_STEP.test(r.message))).toEqual([]);
  });

  it("would catch one without", () => {
    expect(NEXT_STEP.test("PayPal's payment date is not after the recall date.")).toBe(false);
  });
});
