import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { checkClaim, plantedClaims, MAX_QUOTE } from "./claimCheck";

const fixture = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");

describe("what Claude may record, tried with planted claims", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeAll(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });
  afterAll(async () => {
    await db.close();
  });

  it("strikes both planted claims, in the validator's own words", async () => {
    const results = await plantedClaims(db);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.kept).toBe(false);
      expect(r.said).toMatch(/quote is not in/);
    }
    expect(results.map((r) => r.claim).join(" ")).toContain("safe");
  });

  it("keeps a quote that really is in CPSC's words", async () => {
    expect(await checkClaim(db, "can overheat when plugged in")).toMatchObject({ kept: true });
  });

  it("strikes one word changed", async () => {
    expect(await checkClaim(db, "cannot overheat when plugged in")).toMatchObject({ kept: false });
  });

  it("strikes a quote too short to mean anything, and an empty one", async () => {
    expect(await checkClaim(db, "a")).toMatchObject({ kept: false });
    expect(await checkClaim(db, "   ")).toMatchObject({ kept: false });
  });

  it("won't read a very long one", async () => {
    expect(await checkClaim(db, "x".repeat(MAX_QUOTE + 1))).toMatchObject({ kept: false });
  });

  it("runs the same validator Claude's findings go through", () => {
    const source = readFileSync("server/safety/claimCheck.ts", "utf8");
    expect(source).toMatch(/import \{[^}]*findingProblem[^}]*\} from "\.\.\/agent\/recallAgent"/);
    expect(source).not.toMatch(/askClaude|anthropic/i);
  });
});
