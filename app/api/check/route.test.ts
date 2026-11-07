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

  describe("when the rules rule a recall out, but CPSC's text has what was typed", () => {
    const mentioned = async (query: string) => {
      const body = await results(query);
      return { named: body.results.map((r: { recallNumber: string }) => r.recallNumber), mentioned: body.mentioned.recalls.map((r: { recallNumber: string }) => r.recallNumber), total: body.mentioned.total };
    };

    it("names a recall from the maker alone", async () => {
      expect((await mentioned("title=Baby+Brezza")).mentioned).toContain("27072");
    });

    it("names one from a single product word the rules can't settle on", async () => {
      expect((await mentioned("title=sterilizer")).mentioned).toContain("27072");
    });

    it("names one from part of the maker's name, when one word of it is rare", async () => {
      await real.query("update recalls set title = 'Zorbex USA Recalls French Press Coffee Makers' where recall_number = '27072'");
      expect((await mentioned("title=Zorbex")).mentioned).toContain("27072");
      expect((await mentioned("title=Zorbex+Chambord+eight+cup")).mentioned).toContain("27072");
    });

    it("names one from a number the rules read as too short to be a model", async () => {
      await real.query("update recalls set description = 'This recall involves swings, models 1026 and 4M-1037.' where recall_number = '27012'");
      expect((await mentioned("model=1026")).mentioned).toContain("27012");
    });

    it.each(["sterilizers", "STERILIZER", "Sterilizer's"])("finds a word however it's written: %s", async (typed) => {
      expect((await mentioned(`title=${encodeURIComponent(typed)}`)).mentioned).toContain("27072");
    });

    it("finds a plural that ends in es, whose singular isn't what's left without the s", async () => {
      await real.query("update recalls set title = 'Zorbex Recalls French Press Coffee Makers', products = '[]'::jsonb, description = 'This recall involves a French press.' where recall_number = '27072'");
      expect((await mentioned(`title=${encodeURIComponent("zorbex presses")}`)).mentioned).toContain("27072");
      expect((await mentioned(`title=${encodeURIComponent("french presses")}`)).mentioned).toContain("27072");
      expect((await mentioned(`title=${encodeURIComponent("presses")}`)).mentioned).toContain("27072");
    });

    it("doesn't take a word other recalls have for a slip: chair isn't one letter off hair", async () => {
      await real.query("update recalls set title = 'Zorbex Recalls Hair Dryers', description = 'This recall involves hair dryers.', products = '[]'::jsonb where recall_number = '27072'");
      await real.query("update recalls set description = description || ' A high chair.' where recall_number in ('27012', '27040')");
      const found = await mentioned(`title=${encodeURIComponent("Graco high chair")}`);
      expect(found.mentioned).not.toContain("27072");
      expect(found.total).toBe(0);
    });

    it("counts a recall holding all but one of four or more typed words as could be", async () => {
      await real.query("update recalls set title = 'Zorbex Recalls River Street Five Drawer Chests', description = 'This recall involves chests.', products = '[]'::jsonb where recall_number = '27072'");
      await real.query("update recalls set description = description || ' A river street five drawer chest.' where recall_number in ('27012', '27040', '27055')");
      expect((await mentioned(`title=${encodeURIComponent("River Street Fibe Drawer Chests")}`)).mentioned).toContain("27072");
    });

    it("counts one letter wrong in a word of the recall's name as could be", async () => {
      await real.query("update recalls set title = 'Zorbex Recalls Infant Swings', description = 'This recall involves swings.', products = '[{\"name\":\"Infant Swings\",\"model\":\"\",\"type\":null,\"units\":null}]'::jsonb where recall_number = '27072'");
      expect((await mentioned(`title=${encodeURIComponent("Zorbx")}`)).mentioned).toContain("27072");
      expect((await mentioned(`title=${encodeURIComponent("infant swng")}`)).mentioned.concat((await results(`title=${encodeURIComponent("infant swng")}`)).results.filter((r: { sharesWords: boolean }) => r.sharesWords).map((r: { recallNumber: string }) => r.recallNumber))).toContain("27072");
    });

    it("doesn't take a plural for a slip, so another maker's product stays only the same kind", async () => {
      await real.query("update recalls set description = description || ' A high chair.' where recall_number in ('27012', '27072')");
      const body = await results(`title=${encodeURIComponent("Graco high chairs")}`);
      expect(body.results.length).toBeGreaterThan(0);
      for (const r of body.results) expect(r.sharesWords).toBe(false);
    });

    it("names one from a maker too short to count as a word", async () => {
      await real.query("update recalls set title = 'H&M Recalls Bath Mats', description = 'This recall involves bath mats.' where recall_number = '27072'");
      expect((await mentioned(`title=${encodeURIComponent("H&M")}`)).mentioned).toContain("27072");
    });

    it("says which results share what was typed, and which only share the kind of product", async () => {
      await real.query("update recalls set description = description || ' A high chair.' where recall_number in ('27012', '27072')");
      const results_ = async (query: string) => (await results(query)).results as { recallNumber: string; sharesWords: boolean; tiedToRecall: boolean }[];
      const graco = await results_(`title=${encodeURIComponent("Graco high chair")}`);
      expect(graco.length).toBeGreaterThan(0);
      for (const r of graco) expect(r).toMatchObject({ tiedToRecall: false, sharesWords: false });
      expect((await results_(`title=${encodeURIComponent("high chair")}`)).some((r) => r.sharesWords)).toBe(true);
    });

    it("doesn't repeat a recall that's already a result, and counts the rest", async () => {
      const found = await mentioned("title=chair");
      expect(found.mentioned.filter((n: string) => found.named.includes(n))).toEqual([]);
      expect(found.total).toBeGreaterThanOrEqual(found.mentioned.length);
    });

    it("isn't looked for once a recall is tied to the text", async () => {
      expect(await mentioned("title=Baby+Brezza+sterilizer&model=BRZ0083")).toMatchObject({ mentioned: [], total: 0 });
    });

    it("stays empty when CPSC's text doesn't have it", async () => {
      expect(await mentioned("title=zzqx+vvbn+plmk")).toMatchObject({ mentioned: [], total: 0 });
    });
  });

  it("reads a model typed into the label field as that model, spaced or not", async () => {
    for (const title of ["BRZ 0083", "BRZ0083", "brz-0083"]) expect((await results(`title=${encodeURIComponent(title)}`)).results[0]).toMatchObject({ recallNumber: "27072", verdict: "MATCH" });
  });

  it("reads a long number typed alone into the label field as a model to read", async () => {
    expect((await results("title=406198")).results[0]).toMatchObject({ recallNumber: "27012", verdict: "SCOPE_GAP", tiedToRecall: true });
  });

  it("lists a recall tied to the text before ones that only share a kind of product", async () => {
    const body = await results(`title=${encodeURIComponent("Costway high chair")}`);
    const tied = body.results.map((r: { tiedToRecall: boolean }) => r.tiedToRecall);
    expect(tied.indexOf(false) === -1 || tied.lastIndexOf(true) < tied.indexOf(false)).toBe(true);
    expect(tied).toContain(true);
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

  it("counts a check, and only that", async () => {
    await results("title=SECRET-TITLE+chair");
    const { rows } = await real.query<{ surface: string; calls: number }>("select surface, calls from public_calls");
    expect(rows).toEqual([{ surface: "api", calls: 1 }]);
    expect(JSON.stringify(rows)).not.toContain("SECRET-TITLE");
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

  it.each(["BRZ0083", "BRZ-0083", "BRZ.0083", "BRZ 0083", "brz0083"])("finds the recall from the model alone, however it's written: %s", async (model) => {
    const body = await results(`model=${encodeURIComponent(model)}`);
    expect(body.results[0]).toMatchObject({ recallNumber: "27072", verdict: "MATCH" });
  });

  it("finds a model that is only digits, as something to read, not a match", async () => {
    const body = await results("model=406198");
    expect(body.results[0]).toMatchObject({ recallNumber: "27012", verdict: "SCOPE_GAP", tiedToRecall: true });
    expect(body.results[0].reason).toContain("406198");
    expect(body.results[0].missing.length).toBeGreaterThan(0);
  });

  it.each(["2026", "000", "406", "19"])("doesn't take %s for a model because those digits are somewhere in a recall", async (model) => {
    const body = await results(`model=${model}`);
    expect(body.results.map((r: { recallNumber: string }) => r.recallNumber)).not.toContain("27012");
  });

  it.each(["1234567", "8001234567"])("doesn't take the pieces of a phone number for a model: %s", async (model) => {
    await real.query("update recalls set description = 'Model LMP100 is recalled. Call (800) 123-4567 or 800-123-4567 for help.' where recall_number = '27012'");
    const body = await results(`model=${model}`);
    expect(body.results.map((r: { recallNumber: string }) => r.recallNumber)).not.toContain("27012");
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
