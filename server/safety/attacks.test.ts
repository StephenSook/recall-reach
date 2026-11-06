import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { latestSafetyRun, runSafetyAttacks, runSafetyChecks } from "./attacks";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const NOW = new Date("2026-11-06T15:00:00Z");
const SECRET = "k".repeat(32);

describe("the safety checks", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });
  const run = () => runSafetyAttacks(db, { now: NOW, secret: SECRET });
  const outcomeOf = async (id: string) => (await run()).find((r) => r.id === id);

  it("all five are refused by the real code, with what stopped each one", async () => {
    const results = await run();
    expect(results.map((r) => [r.id, r.outcome])).toEqual([
      ["injected-title", "REFUSED"],
      ["forged-webhook", "REFUSED"],
      ["replayed-refund", "REFUSED"],
      ["past-180-days", "REFUSED"],
      ["near-miss", "REFUSED"],
    ]);
  });

  it("says what really stopped each one", async () => {
    const results = await run();
    const detail = (id: string) => results.find((r) => r.id === id)?.detail;
    expect(detail("injected-title")).toContain("no refund tool");
    expect(detail("forged-webhook")).toContain("401");
    expect(detail("replayed-refund")).toContain("already used");
    expect(detail("replayed-refund")).toContain("PayPal was asked once");
    expect(detail("past-180-days")).toContain("refund window closed");
    expect(detail("near-miss")).toContain("It cleared");
  });

  it("leaves nothing behind", async () => {
    await run();
    const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n;
    for (const table of ["shops", "order_lines", "recall_matches", "paypal_payments", "approvals", "refunds", "paypal_refund_refs", "notices", "agent_runs", "paypal_webhook_events"]) {
      expect(await count(table), table).toBe(0);
    }
  });

  it("spends nothing against the day's Claude limit", async () => {
    await run();
    const { rows } = await db.query<{ total: number | null }>("select sum(cost_micros)::int as total from agent_spend");
    expect(rows[0].total ?? 0).toBe(0);
  });

  it("says a check could not run, rather than calling it refused", async () => {
    await db.query("delete from recalls where recall_number = '27027'");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await run();
    expect(results.find((r) => r.id === "replayed-refund")?.outcome).toBe("NOT_RUN");
    expect(results.find((r) => r.id === "past-180-days")?.outcome).toBe("NOT_RUN");
    expect(errors).toHaveBeenCalled();
  });

  it("says the Claude check didn't run when the day's limit stops it, rather than calling it refused", async () => {
    await db.query("insert into agent_spend (day, cost_micros) values ('2026-11-06', 999999999)");
    expect((await outcomeOf("injected-title"))?.outcome).toBe("NOT_RUN");
  });

  it("keeps the latest run for the page, and only the last few", async () => {
    expect(await latestSafetyRun(db)).toBeNull();
    for (let i = 0; i < 7; i++) await runSafetyChecks(db, { now: NOW, secret: SECRET });
    const latest = await latestSafetyRun(db);
    expect(latest?.results).toHaveLength(5);
    expect(latest?.ms).toBeGreaterThan(0);
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from safety_runs");
    expect(rows[0].n).toBe(5);
  });
});
