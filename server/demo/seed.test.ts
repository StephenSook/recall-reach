import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Method, PayPalClient, RequestOptions } from "../paypal/client";
import { createContactCipher } from "../privacy/contactCipher";
import { DEMO_LABEL, seedDemoShop } from "./seed";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const SECRET = "k".repeat(32);
const TODAY = "2026-11-06";

/** A PayPal stand-in that remembers each order it was asked to create and reads it back. */
function fakePayPal() {
  const orders = new Map<string, Record<string, unknown>>();
  const calls: { method: Method; path: string; opts: RequestOptions }[] = [];
  const client: PayPalClient = {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      if (method === "POST" && path === "/v2/checkout/orders") {
        const id = `ORDER-${orders.size + 1}`;
        const unit = (opts.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0];
        orders.set(id, {
          id,
          status: "COMPLETED",
          purchase_units: [
            {
              ...unit,
              payments: {
                captures: [{ id: `CAP-${orders.size + 1}`, status: "COMPLETED", create_time: `${TODAY}T14:00:00Z`, amount: (unit.amount as { currency_code: string; value: string }) }],
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

  it("creates the three golden-path cases on real recalls", async () => {
    const { shopId } = await seed(fakePayPal().client);
    expect(await matches(shopId)).toMatchObject([
      { recall_number: "27027", verdict: "MATCH", sale_path: "REFUND_ELIGIBLE", join_state: "IDENTIFIED", ordered_on: TODAY },
      { recall_number: "27040", verdict: "SCOPE_GAP", sale_path: "NOTICE_ONLY", join_state: "IDENTIFIED" },
      { recall_number: "27072", verdict: "MATCH", sale_path: "NOTICE_ONLY", join_state: "IDENTIFIED" },
    ]);
  });

  it("labels the shop and every line as demo data, and says when a date is seeded", async () => {
    const { shopId } = await seed(fakePayPal().client);
    const { rows: shop } = await db.query<{ name: string; kind: string }>("select name, kind from shops where id = $1", [shopId]);
    expect(shop[0]).toEqual({ name: DEMO_LABEL, kind: "DEMO" });
    const lines = await matches(shopId);
    for (const l of lines) expect(String(l.source)).toMatch(/^DEMO SHOP/);
    expect(lines.find((l) => l.recall_number === "27072")?.source).toMatch(/seeded/);
    expect(lines.find((l) => l.recall_number === "27027")?.source).toMatch(/today/);
  });

  it("makes one real capture per order, carrying its SKU and the shop's own order number", async () => {
    const pp = fakePayPal();
    await seed(pp.client);
    const posts = pp.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(3);
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
    expect(new Set(numbers).size).toBe(6);
  });

  it("stores PayPal's answers in the 46-hour table", async () => {
    const { shopId } = await seed(fakePayPal().client);
    const { rows } = await db.query<Record<string, unknown>>("select order_number, capture_id, capture_status, amount_cents, currency from paypal_payments where shop_id = $1", [shopId]);
    expect(rows).toHaveLength(3);
    for (const p of rows) expect(p).toMatchObject({ capture_status: "COMPLETED", currency: "USD" });
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
