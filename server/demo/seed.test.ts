import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Method, PayPalClient, RequestOptions } from "../paypal/client";
import { approveRefund } from "../paypal/refunds";
import { createContactCipher } from "../privacy/contactCipher";
import { DEMO_LABEL, seedDemoShop } from "./seed";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const extraText = readFileSync(new URL("../../test/fixtures/cpsc/demo_cases_extra.json", import.meta.url), "utf8");
const SECRET = "k".repeat(32);
const TODAY = "2026-11-06";

/** A PayPal stand-in that remembers each order it was asked to create and reads it back. */
function fakePayPal(over: { searchFails?: boolean; searchFailsOnce?: boolean } = {}) {
  let searches = 0;
  const orders = new Map<string, Record<string, unknown>>();
  const calls: { method: Method; path: string; opts: RequestOptions }[] = [];
  const client: PayPalClient = {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      const failNow = over.searchFails || (over.searchFailsOnce && path.startsWith("/v1/reporting") && searches++ === 0);
      const found = answerSearch(path, Boolean(failNow));
      if (found) return found;
      if (method === "POST" && path === "/v2/checkout/orders") {
        const id = `ORDER-${orders.size + 1}`;
        const unit = (opts.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0];
        orders.set(`CAP-${orders.size + 1}`, { id: `CAP-${orders.size + 1}`, status: "COMPLETED", create_time: `${TODAY}T14:00:00Z`, amount: unit.amount });
        orders.set(id, {
          id,
          status: "COMPLETED",
          purchase_units: [
            {
              ...unit,
              payments: {
                captures: [{ id: `CAP-${orders.size}`, status: "COMPLETED", create_time: `${TODAY}T14:00:00Z`, amount: (unit.amount as { currency_code: string; value: string }) }],
              },
            },
          ],
        });
        return { status: 201, data: { id, status: "COMPLETED" } };
      }
      const order = orders.get(path.split("/").pop() ?? "");
      if (method === "GET" && order) return { status: 200, data: order };
      throw new Error(`unexpected ${method} ${path}`);
    }) as PayPalClient["request"],
  };
  return { client, calls };
}

describe("seedDemoShop", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    const extra = async () => new Response(extraText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-08-01", end: "2026-08-31" }, { fetchImpl: extra as typeof fetch });
  });
  afterEach(async () => {
    await db.close();
  });

  const seed = (client: PayPalClient, demoEmail?: string) => seedDemoShop(db, client, { today: TODAY, secret: SECRET, demoEmail });
  const matches = async (shopId: string) =>
    (
      await db.query<Record<string, unknown>>(
        `select r.recall_number, m.verdict, m.sale_path, m.join_state, l.ordered_on, l.source
         from recall_matches m join recalls r using (recall_id) join order_lines l on l.id = m.order_line_id
         where m.shop_id = $1 and m.verdict <> 'CLEARED' order by r.recall_number`,
        [shopId],
      )
    ).rows;

  describe("the cases in research/DEMO-CASES.md, on real recalls", () => {
    const lineFor = async (shopId: string, recallNumber: string, title: RegExp) => {
      const { rows } = await db.query<{ verdict: string; strength: string; sale_path: string; join_state: string; title: string; ordered_on: string; id: string }>(
        `select m.id, m.verdict, m.strength, m.sale_path, m.join_state, l.title, l.ordered_on from recall_matches m join recalls r using (recall_id) join order_lines l on l.id = m.order_line_id
         where m.shop_id = $1 and r.recall_number = $2`,
        [shopId, recallNumber],
      );
      return rows.filter((r) => title.test(r.title));
    };

    it("NOTICE ONLY: a confirmed match sold before the recall, linked to a payment PayPal's search found", async () => {
      const { shopId } = await seed(fakePayPal().client);
      expect((await lineFor(shopId, "27072", /BRZ0083/))[0]).toMatchObject({ verdict: "MATCH", sale_path: "NOTICE_ONLY", join_state: "IDENTIFIED" });
    });

    it("REFUND ELIGIBLE: a confirmed match really sold after the recall, with a capture made just now", async () => {
      const { shopId } = await seed(fakePayPal().client);
      expect((await lineFor(shopId, "27027", /moon$/))[0]).toMatchObject({ verdict: "MATCH", sale_path: "REFUND_ELIGIBLE", join_state: "IDENTIFIED", ordered_on: TODAY });
    });

    it("MIXED BASKET: one order with a clothing lot and a discount, which refunds the sleeper's share only", async () => {
      const pp = fakePayPal();
      const { shopId } = await seed(pp.client);
      const [sleeper] = await lineFor(shopId, "27027", /like new/);
      expect(sleeper).toMatchObject({ verdict: "MATCH", sale_path: "REFUND_ELIGIBLE", join_state: "IDENTIFIED" });
      const approval = await approveRefund(db, pp.client, { shopId, sessionId: "s", matchId: sleeper.id });
      expect(approval.amountCents).toBe(8250); // $90.00 less its $7.50 share of the $10.00 order discount
      const posted = pp.calls.filter((c) => c.method === "POST").map((c) => (c.opts.body as { purchase_units: { items: unknown[]; amount: { value: string } }[] }).purchase_units[0]);
      const basket = posted.find((u) => u.items.length === 2);
      expect(basket?.amount.value).toBe("110.00");
    });

    it("SCOPE GAP: names the missing fact, and the row's date is seeded before the recall", async () => {
      const { shopId } = await seed(fakePayPal().client);
      expect((await lineFor(shopId, "27040", /Costway/))[0]).toMatchObject({ verdict: "SCOPE_GAP", sale_path: "NOTICE_ONLY", join_state: "IDENTIFIED" });
    });

    it("CAN'T TELL: a recall whose list is only on CPSC's site is never cleared", async () => {
      const { shopId } = await seed(fakePayPal().client);
      const [row] = await lineFor(shopId, "26724", /Little Loves/);
      expect(row.verdict).toBe("SCOPE_GAP");
    });

    it("NEAR MISS: the same brand, a different product, clears with its reason", async () => {
      const { shopId } = await seed(fakePayPal().client);
      expect((await lineFor(shopId, "27072", /Formula Pro/))[0]).toMatchObject({ verdict: "CLEARED", join_state: "IDENTIFIED" });
    });

    it("AMBIGUOUS JOIN: two lines could claim one payment, so nothing goes out on either", async () => {
      const { shopId } = await seed(fakePayPal().client);
      const rows = await lineFor(shopId, "26688", /Taleco/);
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.join_state).toBe("AMBIGUOUS_JOIN");
    });

    it("CANNOT IDENTIFY: the payment that only says an amount is counted, and links to nothing", async () => {
      const { run } = await seed(fakePayPal().client);
      expect(run.unidentifiedPayments).toBe(1);
    });
  });

  describe("reading PayPal's history", () => {
    it("searches for real, and says so", async () => {
      const pp = fakePayPal();
      const { shopId } = await seed(pp.client);
      expect(pp.calls.filter((c) => c.path === "/v1/reporting/transactions").length).toBeGreaterThan(0);
      const { rows } = await db.query<{ paypal_searched: boolean; search_windows: number; failed_windows: number; rows_read: number; searched_from: string; searched_to: string }>("select * from shop_runs where shop_id = $1", [shopId]);
      expect(rows[0]).toMatchObject({ paypal_searched: true, failed_windows: 0 });
      expect(rows[0].search_windows).toBeGreaterThan(0);
      expect(rows[0].rows_read).toBeGreaterThan(0);
    });

    it("searches the dates it says it searched", async () => {
      const pp = fakePayPal();
      const { shopId } = await seedDemoShop(db, pp.client, { today: TODAY, secret: SECRET, now: new Date(`${TODAY}T15:00:00Z`) });
      const asked = pp.calls.filter((c) => c.path === "/v1/reporting/transactions").map((c) => c.opts.query as { start_date: string; end_date: string });
      const { rows } = await db.query<{ searched_from: string; searched_to: string }>("select searched_from, searched_to from shop_runs where shop_id = $1", [shopId]);
      expect(rows[0].searched_from).toBe(asked[0].start_date.slice(0, 10));
      expect(rows[0].searched_to).toBe(asked.at(-1)?.end_date.slice(0, 10));
    });

    it("leaves out a case whose recall isn't loaded, along with its standing payment", async () => {
      const { shopId, run } = await seed(fakePayPal().client);
      const lines = await db.query("select id from order_lines where shop_id = $1 and sku = 'DEMO-MAMAROO'", [shopId]);
      const payments = await db.query("select id from paypal_payments where shop_id = $1 and order_number = 'DEMO-HIST-MAMAROO'", [shopId]);
      expect(lines.rows).toEqual([]);
      expect(payments.rows).toEqual([]);
      expect(run.unidentifiedPayments).toBe(1); // the payment that says only an amount
    });

    it("shows the dates it searched on the US calendar, like every other date on the page", async () => {
      const lateEvening = new Date("2026-11-06T03:49:00Z"); // 10:49 PM on Nov 5 in New York
      const { shopId } = await seedDemoShop(db, fakePayPal().client, { today: "2026-11-05", secret: SECRET, now: lateEvening });
      const { rows } = await db.query<{ searched_from: string; searched_to: string }>("select searched_from, searched_to from shop_runs where shop_id = $1", [shopId]);
      expect(rows[0].searched_to).toBe("2026-11-05");
      expect(rows[0].searched_from).toBe("2026-09-04");
    });

    it("takes only the demo's standing payments: another session's sale is not this shop's", async () => {
      const { shopId } = await seed(fakePayPal().client);
      const { rows } = await db.query<{ order_number: string | null }>("select order_number from paypal_payments where shop_id = $1", [shopId]);
      expect(rows.map((r) => r.order_number)).not.toContain("DEMO-abcd1234-1");
      expect(rows.some((r) => r.order_number === "DEMO-HIST-BREZZA")).toBe(true);
    });

    it("finds a payment with no invoice by the pool's SKU", async () => {
      const { shopId } = await seed(fakePayPal().client);
      const { rows } = await db.query<{ items: { sku: string }[] }>("select items from paypal_payments where shop_id = $1 and order_number is null", [shopId]);
      expect(rows.map((r) => r.items[0]?.sku)).toEqual(["DEMO-TALECO"]);
    });

    it("never spends a capture on what the pool already holds, and never refunds the pool", async () => {
      const pp = fakePayPal();
      await seed(pp.client);
      const invoices = pp.calls.filter((c) => c.method === "POST").map((c) => (c.opts.body as { purchase_units: { invoice_id: string }[] }).purchase_units[0].invoice_id);
      expect(invoices.some((i) => i.startsWith("DEMO-HIST"))).toBe(false);
    });

    it("says nothing was fully searched when every search fails, and no sale reads as no record", async () => {
      const { shopId } = await seed(fakePayPal({ searchFails: true }).client);
      const { rows } = await db.query<{ paypal_searched: boolean; failed_windows: number; search_windows: number }>("select paypal_searched, failed_windows, search_windows from shop_runs where shop_id = $1", [shopId]);
      expect(rows[0].paypal_searched).toBe(false);
      expect(rows[0].failed_windows).toBe(rows[0].search_windows);
      const lines = await matches(shopId);
      expect(lines.some((l) => l.join_state === "NO_PAYPAL_RECORD")).toBe(false);
      expect(lines.find((l) => l.recall_number === "27040")?.join_state).toBe("HISTORY_UNAVAILABLE");
    });

    it("says so when one search of several fails", async () => {
      const { shopId } = await seed(fakePayPal({ searchFailsOnce: true }).client);
      const { rows } = await db.query<{ paypal_searched: boolean; failed_windows: number }>("select paypal_searched, failed_windows from shop_runs where shop_id = $1", [shopId]);
      expect(rows[0]).toMatchObject({ paypal_searched: false, failed_windows: 1 });
    });

    it("still makes a shop when PayPal's search is down: the fresh sale can still be checked", async () => {
      const { shopId } = await seed(fakePayPal({ searchFails: true }).client);
      expect((await matches(shopId)).find((l) => l.recall_number === "27027")).toMatchObject({ verdict: "MATCH", join_state: "IDENTIFIED" });
    });
  });

  it("labels the shop and every line as demo data, and says when a date is seeded", async () => {
    const { shopId } = await seed(fakePayPal().client);
    const { rows: shop } = await db.query<{ name: string; kind: string }>("select name, kind from shops where id = $1", [shopId]);
    expect(shop[0]).toEqual({ name: DEMO_LABEL, kind: "DEMO" });
    const lines = await matches(shopId);
    for (const l of lines) expect(String(l.source)).toMatch(/^DEMO SHOP/);
    // A line can sit beside many recalls, so its label must be true beside all of them.
    for (const l of lines) expect(String(l.source)).not.toMatch(/recall|eligible|notice only|scope gap/i);
    expect(lines.find((l) => l.recall_number === "27072")?.source).toMatch(/seeded/);
    expect(lines.find((l) => l.recall_number === "27027")?.source).toMatch(/today/);
  });

  it("makes a real capture only where a refund is possible, carrying its SKU and the shop's own order number", async () => {
    const pp = fakePayPal();
    await seed(pp.client);
    const posts = pp.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      const unit = (p.opts.body as { purchase_units: { invoice_id: string; custom_id: string; items: { sku: string }[] }[] }).purchase_units[0];
      expect(unit.invoice_id).toMatch(/^DEMO-[0-9a-f]{8}-\d+$/);
      expect(unit.custom_id).toBe(unit.invoice_id);
      expect(unit.items[0].sku).toBeTruthy();
      expect(p.opts.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("gives each shop its own order numbers, because PayPal refuses a duplicate invoice id", async () => {
    const pp = fakePayPal();
    await seed(pp.client);
    await seed(pp.client);
    const numbers = pp.calls
      .filter((c) => c.method === "POST")
      .map((c) => (c.opts.body as { purchase_units: { invoice_id: string }[] }).purchase_units[0].invoice_id);
    expect(numbers).toHaveLength(4);
    expect(new Set(numbers).size).toBe(4);
  });

  it("stores PayPal's answers in the 46-hour table", async () => {
    const { shopId } = await seed(fakePayPal().client);
    const { rows } = await db.query<Record<string, unknown>>("select order_number, capture_id, capture_status, amount_cents, currency from paypal_payments where shop_id = $1", [shopId]);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const p of rows) expect(p.currency).toBe("USD");
  });

  it("seals the demo inbox into the shop record when one is set, and leaves it out when not", async () => {
    const withInbox = await seed(fakePayPal().client, "test-inbox@example.test");
    const { rows } = await db.query<{ buyer_email_enc: string | null }>("select buyer_email_enc from order_lines where shop_id = $1", [withInbox.shopId]);
    expect(rows.every((r) => r.buyer_email_enc)).toBe(true);
    expect(createContactCipher(SECRET, withInbox.shopId).open(rows[0].buyer_email_enc!)).toBe("test-inbox@example.test");
    const without = await seed(fakePayPal().client);
    const none = await db.query<{ buyer_email_enc: string | null }>("select buyer_email_enc from order_lines where shop_id = $1", [without.shopId]);
    expect(none.rows.every((r) => r.buyer_email_enc === null)).toBe(true);
  });

  it("reads the recall date from the database: a seeded date stays before the recall it is for", async () => {
    const { shopId } = await seed(fakePayPal().client);
    const { rows } = await db.query<{ ordered_on: string; recall_date: string }>(
      `select l.ordered_on, r.recall_date from recall_matches m join recalls r using (recall_id) join order_lines l on l.id = m.order_line_id
       where m.shop_id = $1 and r.recall_number = '27072'`,
      [shopId],
    );
    expect(rows[0].ordered_on < rows[0].recall_date).toBe(true);
  });

  it("refuses to seed when a case's recall is not loaded, rather than inventing it", async () => {
    await db.query("delete from recalls where recall_number = '27072'");
    await expect(seed(fakePayPal().client)).rejects.toThrow(/27072/);
  });
});
