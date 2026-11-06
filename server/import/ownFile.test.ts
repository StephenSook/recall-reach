import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { prepareNotice } from "../notice/store";
import type { PayPalClient } from "../paypal/client";
import { approveRefund, RefundRefused } from "../paypal/refunds";
import { createContactCipher } from "../privacy/contactCipher";
import { loadQueue } from "../queue/queue";
import { createShop } from "./store";
import { deleteOwnShop, importOwnFile, MAX_LINES, OwnFileRefused, purgeOldDemoShops, purgeOldOwnShops } from "./ownFile";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const SECRET = "k".repeat(32);
const TODAY = "2026-11-06";
const HEADER = "order_number,title,sku,quantity,unit_price,currency,ordered_on,buyer_email";
const row = (n: number, title: string, on = "2026-09-15", email = "family@example.test") => `S-${n},${title},,1,90.00,USD,${on},${email}`;
const FILE = [HEADER, row(1, "Baby Brezza SuperFast Sterilizer Dryer BRZ0083"), row(2, "Costway high chair"), row(3, "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "2026-11-06")].join("\n");

const paypalMustNotBeCalled: PayPalClient = {
  request: (async () => {
    throw new Error("a shop's own file connects no PayPal account");
  }) as PayPalClient["request"],
};

describe("a shop checking its own order file", () => {
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

  const load = (csv = FILE, shopName = "Little Sprouts") => importOwnFile(db, { shopName, csv, secret: SECRET, today: TODAY });
  const shopCount = async () => Number((await db.query<{ n: string }>("select count(*)::text as n from shops")).rows[0].n);
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => "no refusal",
      (e: unknown) => (e instanceof OwnFileRefused ? e.code : `other: ${String(e)}`),
    );

  it("makes a real shop under its own name, and checks its file against real recalls", async () => {
    const { shopId, lines } = await load();
    expect(lines).toBe(3);
    const q = await loadQueue(db, shopId, "s");
    expect(q.shop).toEqual({ name: "Little Sprouts", kind: "REAL" });
    expect(q.rows.find((r) => r.recallNumber === "27072")).toMatchObject({ verdict: "MATCH", strength: "CONFIRMED" });
    expect(q.rows.find((r) => r.recallNumber === "27040")).toMatchObject({ verdict: "SCOPE_GAP" });
  });

  it("says PayPal was not searched, and never reads an absent payment as no record", async () => {
    const { shopId } = await load();
    const q = await loadQueue(db, shopId, "s");
    expect(q.coverage).toMatchObject({ paypalSearched: false, searchWindows: 0 });
    for (const r of q.rows) expect(r.joinState).toBe("HISTORY_UNAVAILABLE");
  });

  it("can't refund anything: no PayPal account is connected", async () => {
    const { shopId } = await load();
    const row = (await loadQueue(db, shopId, "s")).rows.find((r) => r.recallNumber === "27072" && r.salePath === "REFUND_ELIGIBLE");
    expect(row).toBeDefined();
    await expect(approveRefund(db, paypalMustNotBeCalled, { shopId, sessionId: "s", matchId: row?.matchId ?? "" })).rejects.toBeInstanceOf(RefundRefused);
  });

  it("can still reach the family, from the address in the shop's own file", async () => {
    const { shopId } = await load();
    const row = (await loadQueue(db, shopId, "s")).rows.find((r) => r.recallNumber === "27072");
    await expect(prepareNotice(db, { shopId, matchId: row?.matchId ?? "" })).resolves.toMatchObject({ kind: "SAFETY_NOTICE" });
  });

  it("keeps buyer emails encrypted", async () => {
    const { shopId } = await load();
    const { rows } = await db.query<{ buyer_email_enc: string }>("select buyer_email_enc from order_lines where shop_id = $1", [shopId]);
    expect(JSON.stringify(rows)).not.toContain("family@example.test");
    expect(createContactCipher(SECRET, shopId).open(rows[0].buyer_email_enc)).toBe("family@example.test");
  });

  it("says how many rows it could not read", async () => {
    const { rejected, lines } = await load([HEADER, row(1, "Costway high chair"), "S-2,Bad row,,1,not-a-price,USD,2026-09-15,"].join("\n"));
    expect({ lines, rejected }).toEqual({ lines: 1, rejected: 1 });
  });

  it("trims the shop's name and keeps it short", async () => {
    const { shopId } = await load(FILE, `  ${"N".repeat(200)}  `);
    expect((await loadQueue(db, shopId, "s")).shop?.name).toHaveLength(80);
  });

  describe("what it refuses, leaving nothing behind", () => {
    it.each([
      ["NO_NAME", FILE, "   "],
      ["NOT_READABLE", "this is not an order file\njust,some,words", "Shop"],
      ["EMPTY", HEADER, "Shop"],
      ["EMPTY", `${HEADER}\nS-1,Bad,,1,not-a-price,USD,2026-09-15,`, "Shop"],
      ["TOO_MANY", [HEADER, ...Array.from({ length: MAX_LINES + 1 }, (_, i) => row(i, "A title"))].join("\n"), "Shop"],
    ])("%s", async (code, csv, name) => {
      const before = await shopCount();
      expect(await refusal(load(csv, name))).toBe(code);
      expect(await shopCount()).toBe(before);
    });
  });

  describe("deleting it", () => {
    const tablesWithShopId = async () =>
      (await db.query<{ table_name: string }>("select table_name from information_schema.columns where column_name = 'shop_id' and table_schema = 'public'")).rows.map((r) => r.table_name);
    const left = async (shopId: string) => {
      const tables = await tablesWithShopId();
      expect(tables.length).toBeGreaterThan(5);
      const counts: Record<string, number> = {};
      for (const t of tables) counts[t] = Number((await db.query<{ n: string }>(`select count(*)::text as n from ${t} where shop_id = $1`, [shopId])).rows[0].n);
      return Object.entries(counts).filter(([, n]) => n > 0);
    };

    it("removes everything about the shop, across every table", async () => {
      const { shopId } = await load();
      const row = (await loadQueue(db, shopId, "s")).rows.find((r) => r.recallNumber === "27072");
      await prepareNotice(db, { shopId, matchId: row?.matchId ?? "" });
      await db.query(
        `insert into agent_runs (shop_id, recall_sha256, item_sha256, agent_version, outcome, trace, model, input_tokens, output_tokens, cost_micros) values ($1, 'r', 'i', '1', 'NO_FINDING', '[]', 'm', 0, 0, 0)`,
        [shopId],
      );
      expect((await left(shopId)).length).toBeGreaterThan(0);
      expect(await deleteOwnShop(db, shopId)).toBe(true);
      expect(await left(shopId)).toEqual([]);
      expect((await db.query("select 1 from shops where id = $1", [shopId])).rows).toEqual([]);
    });

    it("leaves other shops alone", async () => {
      const mine = await load();
      const theirs = await load(FILE, "Another Shop");
      await deleteOwnShop(db, mine.shopId);
      expect((await left(theirs.shopId)).length).toBeGreaterThan(0);
    });

    it("does not touch a demo shop", async () => {
      const demo = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
      expect(await deleteOwnShop(db, demo)).toBe(false);
      expect((await db.query("select 1 from shops where id = $1", [demo])).rows).toHaveLength(1);
    });
  });

  describe("after seven days", () => {
    const NOW = new Date("2026-11-20T12:00:00Z");
    const age = (shopId: string, days: number) => db.query("update shops set created_at = $2::timestamptz - make_interval(days => $3) where id = $1", [shopId, NOW.toISOString(), days]);

    it("deletes a shop's file by itself, as the screen says it will", async () => {
      const { shopId } = await load();
      await age(shopId, 8);
      expect(await purgeOldOwnShops(db, NOW)).toBe(1);
      expect((await db.query("select 1 from order_lines where shop_id = $1", [shopId])).rows).toEqual([]);
    });

    it("keeps one younger than that", async () => {
      const { shopId } = await load();
      await age(shopId, 6);
      expect(await purgeOldOwnShops(db, NOW)).toBe(0);
    });

    it("deletes a demo shop once its visit is long over, and keeps a recent one", async () => {
      const old = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
      const recent = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
      const own = (await load()).shopId;
      await age(old, 2);
      await age(recent, 1);
      await age(own, 2);
      expect(await purgeOldDemoShops(db, NOW)).toBe(1);
      const { rows } = await db.query<{ id: string }>("select id from shops order by id");
      expect(rows.map((r) => r.id).sort()).toEqual([recent, own].sort());
    });

    it("takes a demo shop before the 48-hour rule, so nothing it was built from can outlast it", async () => {
      const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
      const gone = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
      const kept = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
      await db.query("update shops set created_at = $2::timestamptz where id = $1", [gone, at(47)]);
      await db.query("update shops set created_at = $2::timestamptz where id = $1", [kept, at(45)]);
      await purgeOldDemoShops(db, NOW);
      expect((await db.query<{ id: string }>("select id from shops")).rows.map((r) => r.id)).toEqual([kept]);
    });

    it("leaves demo shops to themselves", async () => {
      const demo = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
      await age(demo, 30);
      expect(await purgeOldOwnShops(db, NOW)).toBe(0);
    });
  });
});
