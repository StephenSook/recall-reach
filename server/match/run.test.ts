import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop, storeOrderLines } from "../import/store";
import type { ImportedOrderLine } from "../import/shopExport";
import { createContactCipher } from "../privacy/contactCipher";
import { runShopCheck } from "./run";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-05";

const line = (orderNumber: string, title: string, orderedOn: string, sku: string | null = null): ImportedOrderLine => ({
  orderNumber,
  lineNo: 1,
  title,
  sku,
  quantity: 1,
  unitPriceCents: 5000,
  discountCents: 0,
  currency: "USD",
  orderedOn,
  paymentReference: null,
  buyerEmail: null,
});

describe("runShopCheck", () => {
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

  const store = (lines: ImportedOrderLine[]) => storeOrderLines(db, shopId, lines, createContactCipher("k".repeat(32), shopId), "test");
  const addPayment = (orderNumber: string | null, capturedAt = `${TODAY}T12:00:00Z`) =>
    db.query(
      `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency)
       values ($1, gen_random_uuid()::text, $2, 'CAP', 'COMPLETED', $3, 5000, 'USD')`,
      [shopId, orderNumber, capturedAt],
    );
  const rows = async () =>
    (
      await db.query<Record<string, unknown>>(
        `select r.recall_number, l.title, m.verdict, m.sale_path, m.join_state, m.matched, m.missing, m.reason, m.recall_sha256, r.raw_sha256
         from recall_matches m join recalls r using (recall_id) join order_lines l on l.id = m.order_line_id
         where m.shop_id = $1 order by r.recall_number`,
        [shopId],
      )
    ).rows;

  it("finds the golden-path cases on real recalls, with verdict, path and join", async () => {
    await store([
      line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15"),
      line("#R1", "Papablic bedside sleeper, gray stars and moon", TODAY),
      line("#G1", "Costway high chair", "2026-08-01"),
    ]);
    await addPayment("#N1");
    await addPayment("#R1");
    const summary = await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
    const byNumber = Object.fromEntries((await rows()).map((r) => [r.recall_number, r]));

    expect(byNumber["27072"]).toMatchObject({ verdict: "MATCH", sale_path: "NOTICE_ONLY", join_state: "IDENTIFIED" });
    expect(byNumber["27027"]).toMatchObject({ verdict: "MATCH", sale_path: "REFUND_ELIGIBLE", join_state: "IDENTIFIED" });
    expect(byNumber["27040"]).toMatchObject({ verdict: "SCOPE_GAP", sale_path: "NOTICE_ONLY", join_state: "NO_PAYPAL_RECORD" });
    expect(summary).toMatchObject({ recallsChecked: 55, matches: 2, scopeGaps: 1 });
  });

  it("records the exact CPSC snapshot each decision read", async () => {
    await store([line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
    await runShopCheck(db, shopId, { today: TODAY });
    const [row] = await rows();
    expect(row.recall_sha256).toBe(row.raw_sha256);
  });

  it("stores a near miss as CLEARED, with the reason", async () => {
    await store([line("#C1", "Baby Brezza Formula Pro Advanced", "2026-09-15")]);
    await runShopCheck(db, shopId, { today: TODAY });
    const brezza = (await rows()).find((r) => r.recall_number === "27072");
    expect(brezza).toMatchObject({ verdict: "CLEARED", reason: expect.stringMatching(/different product/) });
  });

  it("stores how strong the evidence is", async () => {
    await store([line("#S1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
    await runShopCheck(db, shopId, { today: TODAY });
    const { rows: saved } = await db.query<{ strength: string }>(
      `select m.strength from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '27072'`,
      [shopId],
    );
    expect(saved[0].strength).toBe("CONFIRMED");
  });

  it("does not retrieve an unrelated item at all", async () => {
    await store([line("#Z1", "Handmade ceramic garden gnome", "2026-09-15")]);
    const summary = await runShopCheck(db, shopId, { today: TODAY });
    expect((await rows()).filter((r) => r.verdict !== "CLEARED")).toEqual([]);
    expect(summary.matches).toBe(0);
    expect(summary.recallsChecked).toBe(55);
  });

  it("flags a listing that is still for sale, with no path because nothing was sold", async () => {
    await db.query(
      `insert into shop_items (shop_id, title, description, listed, source)
       values ($1, 'Baby Brezza sterilizer', 'Model BRZ0154, lightly used', true, 'test')`,
      [shopId],
    );
    await runShopCheck(db, shopId, { today: TODAY });
    const { rows: found } = await db.query<Record<string, unknown>>(
      `select verdict, sale_path, join_state from recall_matches m join recalls r using (recall_id)
       where m.shop_id = $1 and r.recall_number = '27072' and m.shop_item_id is not null`,
      [shopId],
    );
    expect(found).toEqual([{ verdict: "MATCH", sale_path: null, join_state: null }]);
  });

  it("still matches a sold-out listing: some stores keep them up after the sale", async () => {
    await db.query(
      `insert into shop_items (shop_id, title, description, listed, source)
       values ($1, 'Baby Brezza sterilizer', 'Model BRZ0156', false, 'test')`,
      [shopId],
    );
    await runShopCheck(db, shopId, { today: TODAY });
    const { rows: found } = await db.query<{ verdict: string }>(
      `select verdict from recall_matches m join recalls r using (recall_id)
       where m.shop_id = $1 and r.recall_number = '27072' and m.shop_item_id is not null`,
      [shopId],
    );
    expect(found).toEqual([{ verdict: "MATCH" }]);
  });

  it("retrieves on a model number that appears only in the item's description, in any case", async () => {
    await db.query(
      `insert into shop_items (shop_id, title, description, listed, source)
       values ($1, 'Kitchen appliance, gently used', 'Label says brz0154', true, 'test')`,
      [shopId],
    );
    await runShopCheck(db, shopId, { today: TODAY });
    const { rows: found } = await db.query<{ verdict: string }>(
      `select verdict from recall_matches m join recalls r using (recall_id)
       where m.shop_id = $1 and r.recall_number = '27072'`,
      [shopId],
    );
    expect(found).toEqual([{ verdict: "MATCH" }]);
  });

  it("checks every sale of a popular item: 25 families must not be cut to 20", async () => {
    const sales = Array.from({ length: 25 }, (_, i) => line(`#P${i}`, "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15"));
    await store(sales);
    const summary = await runShopCheck(db, shopId, { today: TODAY });
    expect(summary.matches).toBe(25);
    expect(summary.candidatesNotChecked).toBe(0);
  });

  it("counts what the cap on distinct titles left unchecked, and records it on the run", async () => {
    const lines = Array.from({ length: 23 }, (_, i) => line(`#D${i}`, `Baby Brezza Sterilizer Variant ${String.fromCharCode(65 + i)}`, "2026-09-15"));
    await store(lines);
    const summary = await runShopCheck(db, shopId, { today: TODAY });
    expect(summary.candidatesNotChecked).toBe(3);
    const { rows } = await db.query<{ candidates_not_checked: number }>("select candidates_not_checked from shop_runs where id = $1", [summary.runId]);
    expect(rows[0].candidates_not_checked).toBe(3);
  });

  describe("when this run did not read PayPal", () => {
    const brezzaJoin = async () => (await rows()).find((r) => r.recall_number === "27072")?.join_state;

    it("says history is unavailable, never that PayPal has no record", async () => {
      await store([line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
      const summary = await runShopCheck(db, shopId, { today: TODAY });
      expect(await brezzaJoin()).toBe("HISTORY_UNAVAILABLE");
      const { rows: runs } = await db.query<{ paypal_searched: boolean }>("select paypal_searched from shop_runs where id = $1", [summary.runId]);
      expect(runs[0].paypal_searched).toBe(false);
    });

    it("keeps a join an earlier run established after PayPal's data has aged out", async () => {
      await store([line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
      await addPayment("#N1");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      expect(await brezzaJoin()).toBe("IDENTIFIED");
      await db.query("delete from paypal_payments where shop_id = $1", [shopId]); // the 46-hour purge
      await runShopCheck(db, shopId, { today: TODAY });
      expect(await brezzaJoin()).toBe("IDENTIFIED");
    });

    it("keeps an ambiguous join ambiguous, so outreach stays blocked", async () => {
      await store([line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
      await db.query("update recall_matches set join_state = 'AMBIGUOUS_JOIN' where shop_id = $1", [shopId]);
      await runShopCheck(db, shopId, { today: TODAY });
      await db.query("update recall_matches set join_state = 'AMBIGUOUS_JOIN' where shop_id = $1", [shopId]);
      await runShopCheck(db, shopId, { today: TODAY });
      expect(await brezzaJoin()).toBe("AMBIGUOUS_JOIN");
    });

    it("a run that did read PayPal replaces the state, and records that it searched", async () => {
      await store([line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
      await runShopCheck(db, shopId, { today: TODAY });
      const summary = await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      expect(await brezzaJoin()).toBe("NO_PAYPAL_RECORD");
      const { rows: runs } = await db.query<{ paypal_searched: boolean }>("select paypal_searched from shop_runs where id = $1", [summary.runId]);
      expect(runs[0].paypal_searched).toBe(true);
    });

    it("passes failed search months through to the join", async () => {
      await store([line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true, failedMonths: ["2026-09"] });
      expect(await brezzaJoin()).toBe("HISTORY_UNAVAILABLE");
    });
  });

  it("ignores another shop's records", async () => {
    const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
    await storeOrderLines(db, other, [line("#X", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")], createContactCipher("k".repeat(32), other), "t");
    const summary = await runShopCheck(db, shopId, { today: TODAY });
    expect(summary.matches).toBe(0);
  });

  it("keeps a match's id across runs, so notices stay attached to it", async () => {
    await store([line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
    await runShopCheck(db, shopId, { today: TODAY });
    const ids = async () => (await db.query<{ id: string }>("select id from recall_matches where shop_id = $1 order by id", [shopId])).rows;
    const first = await ids();
    await runShopCheck(db, shopId, { today: TODAY });
    expect(await ids()).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("logs a coverage row: what it searched and how many payments could not be identified", async () => {
    await store([line("#N1", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-09-15")]);
    await addPayment("#N1");
    await addPayment(null);
    await runShopCheck(db, shopId, { today: TODAY });
    const { rows: runs } = await db.query<Record<string, unknown>>("select * from shop_runs where shop_id = $1", [shopId]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ recalls_checked: 55, matches: 1, searched_from: "2026-09-15", searched_to: TODAY, unidentified_payments: 1 });
  });
});
