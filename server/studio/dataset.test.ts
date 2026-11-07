import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import type { Method, PayPalClient } from "../paypal/client";
import { runReplay } from "../replay/replay";
import { STUDIO_TABLES, studioDataset } from "./dataset";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const NOW = new Date(`${TODAY}T15:00:00Z`);
const paypal: PayPalClient = {
  request: (async (method: Method, path: string) => {
    const found = answerSearch(path);
    if (found) return found;
    throw new Error(`unexpected ${method} ${path}`);
  }) as PayPalClient["request"],
};

describe("what AG Studio's agent can see", () => {
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

  it("is nothing before any Replay has run", async () => {
    expect(await studioDataset(db)).toBeNull();
  });

  it("is the latest Replay's rows, labelled the way the page shows them, with CPSC's product name", async () => {
    await runReplay(db, paypal, { today: TODAY, now: NOW, secret: "k".repeat(32) });
    const data = await studioDataset(db);
    expect(data?.rows.length).toBeGreaterThan(0);
    const brezza = data?.rows.find((r) => r.recallNumber === "27072");
    expect(brezza).toMatchObject({ outcome: "Matched", recallYear: 2026, product: expect.stringContaining("Sterilizer") });
    expect(new Set(data?.rows.map((r) => r.outcome))).toEqual(new Set(["Matched", "Can't tell yet", "Cleared", "Nothing near"].filter((o) => data?.rows.some((r) => r.outcome === o))));
    for (const row of data?.rows ?? []) expect(Object.keys(row).sort()).toEqual(["itemTitle", "outcome", "product", "recallDate", "recallNumber", "recallTitle", "recallYear"]);
  });

  it("reads only tables labelled CPSC's, the shop's own or the app's own, never PayPal's", async () => {
    const { rows } = await db.query<{ table_name: string; comment: string | null }>(
      "select c.relname as table_name, obj_description(c.oid, 'pg_class') as comment from pg_class c where c.relkind = 'r' and c.relname = any($1::text[])",
      [STUDIO_TABLES],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...STUDIO_TABLES].sort());
    for (const r of rows) expect(["data-source: cpsc-public", "data-source: shop-owned", "data-source: own"]).toContain(r.comment);
    // Its SQL, with the comments out, since a comment can say "from CPSC".
    const source = readFileSync(new URL("./dataset.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const named = [...source.matchAll(/\b(?:from|join)\s+([a-z_]+)/gi)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const table of named) expect(STUDIO_TABLES).toContain(table);
  });

  it("holds no value from any PayPal-sourced table, so the agent's query tool can't send one to the model", async () => {
    await runReplay(db, paypal, { today: TODAY, now: NOW, secret: "k".repeat(32) });
    // Values only PayPal would have, planted where the app keeps what PayPal returns, beside whatever the run kept.
    // Replay deletes its own shop when it's done, so a shop of its own holds the planted rows.
    const shop = { id: await createShop(db, { name: "A SHOP", kind: "DEMO" }) };
    await db.query(
      `insert into paypal_payments (shop_id, order_id, capture_id, capture_status, amount_cents, currency, items)
       values ($1, 'PLANTEDORDERID77', 'PLANTEDCAPTURE77', 'COMPLETED', 1234, 'USD', '[{"name":"PLANTED PAYPAL ITEM NAME","sku":"PLANTED-SKU-77"}]'::jsonb)`,
      [shop.id],
    );
    await db.query("insert into paypal_calls (shop_id, method, path_template, status, ms, debug_id) values ($1, 'GET', '/PLANTED-PAYPAL-PATH', 200, 1, 'PLANTEDDEBUGID01')", [shop.id]);
    const labelled = await db.query<{ table_name: string }>("select c.relname as table_name from pg_class c where c.relkind = 'r' and obj_description(c.oid, 'pg_class') = 'data-source: paypal'");
    const values = new Set<string>();
    for (const { table_name } of labelled.rows) {
      const { rows } = await db.query<Record<string, unknown>>(`select * from ${table_name}`);
      const walk = (v: unknown): void => {
        if (typeof v === "string") {
          if (v.length >= 6 && !/^\d{4}-\d{2}-\d{2}/.test(v)) values.add(v);
        } else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object" && !(v instanceof Date)) Object.values(v).forEach(walk);
      };
      rows.forEach(walk);
    }
    expect(values.size).toBeGreaterThan(0);
    const json = JSON.stringify(await studioDataset(db));
    expect([...values].filter((v) => json.includes(v))).toEqual([]);
  });
});
