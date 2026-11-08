import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { isShopperExample, latestExampleRun, markExamplePaid, recordExampleRun, SHOPPER_EXAMPLES, type ExampleRunInput } from "./exampleRuns";

const NOW = new Date("2026-11-08T02:00:00.000Z");
const run = (over: Partial<ExampleRunInput> = {}): ExampleRunInput => ({
  ask: "A high chair",
  budgetCents: 20000,
  ranAt: NOW,
  outcome: "PICKED",
  models: ["claude-sonnet-5-5"],
  steps: [
    { kind: "search", query: "high chair", found: 12, inBudget: 9 },
    { kind: "check", title: "Wooden high chair", result: "NO_MATCH_FOUND", recalls: [] },
  ],
  blocked: [{ title: "Convertible high chair", priceCents: 9900, recalls: [{ number: "22113", title: "Recall of convertible high chairs", url: null }] }],
  pick: { title: "Wooden high chair", brand: "Plan Toys", priceCents: 14900, recallsChecked: 934, from: "a shop", similar: 2 },
  slipId: null,
  offerExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
  ...over,
});

describe("the shopping agent's recorded example runs", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("records only a run of one of the page's own examples, so no visitor's words are published", async () => {
    expect(SHOPPER_EXAMPLES.length).toBeGreaterThan(0);
    expect(isShopperExample("A high chair", 20000)).toBe(true);
    expect(isShopperExample("A high chair", 19900)).toBe(false);
    expect(isShopperExample("a high chair for my sister Jo", 20000)).toBe(false);
    expect(await recordExampleRun(db, run({ ask: "a high chair for my sister Jo" }))).toBe(false);
    expect(await latestExampleRun(db)).toBeNull();
    expect(await recordExampleRun(db, run())).toBe(true);
  });

  it("gives back the newest one with its time, its models, what it searched and checked, what it blocked and what it offered", async () => {
    await recordExampleRun(db, run({ ranAt: new Date(NOW.getTime() - 60_000), models: ["claude-haiku-5-5"] }));
    await recordExampleRun(db, run());
    expect(await latestExampleRun(db)).toMatchObject({
      ask: "A high chair",
      budgetCents: 20000,
      ranAt: NOW.toISOString(),
      models: ["claude-sonnet-5-5"],
      steps: run().steps,
      blocked: run().blocked,
      pick: run().pick,
      paidAt: null,
      offerExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    });
  });

  it("keeps the last five", async () => {
    for (let i = 0; i < 7; i++) await recordExampleRun(db, run({ ranAt: new Date(NOW.getTime() + i * 1000) }));
    expect((await db.query<{ n: number }>("select count(*)::int as n from shopper_example_runs")).rows[0].n).toBe(5);
  });

  it("keeps its payment on the run itself, so it outlives the offer row", async () => {
    const { rows } = await db.query<{ id: string }>(
      "insert into shopping_slips (listing_id, title, price_cents, currency, cart_hash, expires_at) values ('L1', 'Wooden high chair', 14900, 'USD', 'h', $1) returning id",
      [new Date(NOW.getTime() + 600_000).toISOString()],
    );
    await recordExampleRun(db, run({ slipId: rows[0].id }));
    await markExamplePaid(db, rows[0].id, new Date(NOW.getTime() + 120_000));
    await db.query("delete from shopping_slips");
    expect((await latestExampleRun(db))?.paidAt).toBe(new Date(NOW.getTime() + 120_000).toISOString());
  });

  it("keeps the table labelled as the app's own", async () => {
    const { rows } = await db.query<{ c: string }>("select obj_description('shopper_example_runs'::regclass, 'pg_class') as c");
    expect(rows[0].c).toBe("data-source: own");
  });
});
