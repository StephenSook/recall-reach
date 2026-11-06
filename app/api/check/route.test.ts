import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { pullRecalls } from "@/server/cpsc/pull";
import { migrate } from "@/server/db/migrate";
import type { Queryable } from "@/server/db/types";

let db: Queryable;
vi.mock("@/server/db/pg", () => ({ getDb: () => db }));

import { GET } from "./route";

const fixtureText = readFileSync(new URL("../../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
let visitor = 0;
const check = (query: string, ip = `198.51.100.${visitor++ % 250}`) =>
  GET(new Request(`http://localhost/api/check?${query}`, { headers: { "true-client-ip": ip } }));

describe("GET /api/check", () => {
  let real: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    real = await testDb();
    await migrate(real);
    db = real;
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(real, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await real.close();
  });

  const results = async (query: string) => {
    const res = await check(query);
    expect(res.status).toBe(200);
    return res.json();
  };

  it("finds a recall when the text names its model, with the recall's own link", async () => {
    const body = await results("title=Baby+Brezza+sterilizer&model=BRZ0083");
    expect(body.results[0]).toMatchObject({ recallNumber: "27072", verdict: "MATCH" });
    expect(body.results[0].url).toMatch(/^https:\/\/www\.cpsc\.gov\//);
    expect(body.results[0].reason).toContain("BRZ0083");
  });

  it("uses the same rules a shop's sale gets: the right product line with nothing to settle scope is a gap, not a match", async () => {
    const body = await results("title=Costway+high+chair");
    const costway = body.results.find((r: { recallNumber: string }) => r.recallNumber === "27040");
    expect(costway.verdict).toBe("SCOPE_GAP");
    expect(costway.missing.length).toBeGreaterThan(0);
    expect(body.results.map((r: { verdict: string }) => r.verdict)).not.toContain("MATCH");
  });

  it("says plainly when nothing comes near, and what it checked against", async () => {
    const body = await results("title=zzqx+vvbn+plmk");
    expect(body.results).toEqual([]);
    expect(body.checked).toMatchObject({ recalls: 55, from: "2026-10-01", to: "2026-11-05" });
  });

  it("names the years it doesn't hold, so a clean answer can't hide a gap", async () => {
    const body = await results("title=zzqx+vvbn+plmk");
    expect(body.checked.yearsMissing).toContain(2022);
  });

  it("says a result is something to read, not a finding about the item", async () => {
    expect((await results("title=Costway+high+chair")).note).toContain("not a finding");
  });

  it("stores nothing it was given", async () => {
    const before = JSON.stringify((await real.query("select (select count(*) from shops) as shops, (select count(*) from order_lines) as lines, (select count(*) from shop_items) as items")).rows);
    await results("title=Baby+Brezza+sterilizer&model=BRZ0083");
    const after = JSON.stringify((await real.query("select (select count(*) from shops) as shops, (select count(*) from order_lines) as lines, (select count(*) from shop_items) as items")).rows);
    expect(after).toBe(before);
  });

  it("can be called from another site's page, since it is public and uses no cookie", async () => {
    expect((await check("title=Costway+high+chair")).headers.get("access-control-allow-origin")).toBe("*");
  });

  it.each([
    ["no text", ""],
    ["blank text", "title=+++"],
    ["one letter", "title=a"],
    ["too long a title", `title=${"x".repeat(201)}`],
    ["too long a model", `title=chair&model=${"x".repeat(61)}`],
  ])("refuses %s, and says what it wants", async (_name, query) => {
    const res = await check(query);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("title");
  });

  it("takes a model alone", async () => {
    expect((await results("model=BRZ0083")).results[0]).toMatchObject({ recallNumber: "27072" });
  });

  it("limits one visitor, and says so", async () => {
    let last = await check("title=chair", "203.0.113.200");
    for (let i = 0; i < 60; i++) last = await check("title=chair", "203.0.113.200");
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBeTruthy();
  });

  it("doesn't repeat what it was asked when the database fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    db = {
      query: async () => {
        throw new Error("failed on a query holding SECRET-TITLE-TEXT");
      },
      exec: async () => {},
    };
    const res = await check("title=SECRET-TITLE-TEXT");
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET-TITLE-TEXT");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("SECRET-TITLE-TEXT");
  });
});
