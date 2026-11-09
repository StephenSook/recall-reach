import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { checkListing, checkText, readListingCheck } from "./textCheck";

const fixture = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-07";

describe("checking a store listing before it can be offered", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });
  afterEach(async () => {
    await db.close();
  });
  /** This fixture holds one month, so the other years read as missing. These tests are about the answer, not the coverage. */
  const checked = async (listing: { title: string; brand: string | null }) => {
    const answer = await checkListing(db, listing, TODAY);
    return { ...answer, checked: { ...answer.checked, yearsMissing: [] } };
  };
  const verdict = async (listing: { title: string; brand: string | null }) => readListingCheck(await checked(listing), listing);

  describe("the model the owner typed", () => {
    it("names it in the recall's own spelling when the recall lists it", async () => {
      const { results } = await checkText(db, { title: "Baby Brezza sterilizer", model: "brz-0083" }, TODAY, { withTypedModel: true });
      expect(results[0]).toMatchObject({ recallNumber: "27072", verdict: "MATCH", modelNamed: "BRZ0083" });
    });

    it("says nothing for a match that came from the title alone", async () => {
      const { results } = await checkText(db, { title: "Baby Brezza BRZ0083", model: "" }, TODAY, { withTypedModel: true });
      expect(results[0]).toMatchObject({ recallNumber: "27072", verdict: "MATCH", modelNamed: null });
    });

    it("says nothing when the typed model isn't one the recall lists", async () => {
      const { results } = await checkText(db, { title: "Baby Brezza SuperFast sterilizer dryer BRZ0083", model: "ZZ9999" }, TODAY, { withTypedModel: true });
      const row = results.find((r) => r.recallNumber === "27072");
      expect(row).toBeDefined();
      expect(row?.modelNamed).toBeNull();
    });

    it("leaves the public answer's shape alone unless asked", async () => {
      const { results } = await checkText(db, { title: "Baby Brezza sterilizer", model: "BRZ0083" }, TODAY);
      expect(results[0]).not.toHaveProperty("modelNamed");
    });
  });

  it("reads the whole listing, so a model far along a long title still names the recall", async () => {
    const title = `Sterilizer ${"very long words ".repeat(30)} BRZ0083`;
    expect(title.length).toBeGreaterThan(400);
    expect(await verdict({ title, brand: "Baby Brezza" })).toBe("NAMES_A_RECALL");
  });

  it("a recall of the maker's same line blocks it, whatever the model", async () => {
    expect(await verdict({ title: "SuperFast Sterilizer Dryer", brand: "Baby Brezza" })).toBe("NAMES_A_RECALL");
  });

  it("a code close to a recalled model blocks it, with no maker named", async () => {
    const answer = await checked({ title: "Bottle sterilizer dryer BRZ0084", brand: null });
    expect(answer.results.find((r) => r.recallNumber === "27072")?.tiedToRecall).toBe(true);
    expect(readListingCheck(answer, { brand: null })).toBe("NAMES_A_RECALL");
  });

  it("the same maker's different product isn't blocked: a maker alone doesn't tie it to this recall", async () => {
    const listing = { title: "SuperFast food warmer", brand: "Bodum" };
    expect(await verdict(listing)).toBe("NO_MATCH_FOUND");
  });

  it("a shared word for who it's for doesn't tie a product to a recall by the same maker", async () => {
    const answer = await checked({ title: "Baby Brezza baby blanket", brand: null });
    expect(answer.results.filter((r) => r.recallNumber === "27072" && r.tiedToRecall)).toEqual([]);
  });

  it("another maker's product of the same kind isn't blocked, and is counted", async () => {
    const listing = { title: "Bottle sterilizer dryer", brand: "Acme" };
    const answer = await checked(listing);
    expect(answer.results.map((r) => r.recallNumber)).toContain("27072");
    expect(readListingCheck(answer, listing)).toBe("NO_MATCH_FOUND");
  });

  it("a recall from the listing's own maker holds it, even when the listing adds an ordinary word, and doesn't claim to name it", async () => {
    const listing = { title: "Wooden Dryer", brand: "Baby Brezza Enterprises" };
    const answer = await checked(listing);
    expect(answer.results.find((r) => r.recallNumber === "27072")).toMatchObject({ strength: "BRAND", tiedToRecall: false });
    expect(readListingCheck(answer, listing)).toBe("MAKER_NOT_RULED_OUT");
  });

  it("finds a recall from the listing's own maker however long the listing's title is", async () => {
    const title = "Compact Electric Countertop Baby Bottle Steam Sterilizer Dryer Machine With Drying Function, Large Capacity For Bottles Pacifiers And Breast Pump Parts, BPA Free, Easy One Button Operation, Ideal Baby Shower Gift For New Parents And Daycare";
    expect(await verdict({ title, brand: "Baby Brezza" })).toBe("NAMES_A_RECALL");
    expect(await verdict({ title, brand: "Baby Brezza Enterprises, LLC" })).toBe("NAMES_A_RECALL");
  });

  it("doesn't clear a code one character from the recalled model when the maker matches", async () => {
    expect(await verdict({ title: "BRZ0081", brand: "Baby Brezza" })).toBe("NAMES_A_RECALL");
    expect(await verdict({ title: "BRZ0081", brand: "Acme" })).toBe("NO_MATCH_FOUND");
  });

  it.each(["BRZ 0081", "BRZ-0081", "BRZ0081/BRZ0082", "BRZ 0081,", "(BRZ 0081)"])("doesn't clear %s, however the code is written", async (title) => {
    expect(await verdict({ title, brand: "Baby Brezza" })).toBe("NAMES_A_RECALL");
  });

  it.each(["Girls Necklace 36 cm", "Leather belt fits waists 20 to 24 inches", "Necklace HO25"])("doesn't read a size or a phrase in %s as a recalled model", async (title) => {
    await db.query("update recalls set title = 'Acme Recalls Rompers Due to Choking Hazard', description = 'This recall involves rompers in sizes 3-6M, styles HO24 and HTO24, tag X36CM.', products = '[{\"name\":\"Rompers\",\"model\":\"\",\"type\":null,\"units\":null}]'::jsonb where recall_number = '27018'");
    expect(await verdict({ title, brand: "Acme" })).toBe("NO_MATCH_FOUND");
  });

  it("finds the recalls of a firm whose name is mostly company words", async () => {
    await db.query("update recalls set title = 'The Company Store Recalls Hooded Robes Due to Burn Hazard', products = '[{\"name\":\"Hooded Robes\",\"model\":\"\",\"type\":null,\"units\":null}]'::jsonb where recall_number = '27018'");
    const listing = { title: "White cotton terry hooded robe for kids, long sleeves and front pockets, matching belt, cozy comfortable bath wear for children, great after a shower or swimming", brand: "The Company Store" };
    expect((await checked(listing)).results.map((r) => r.recallNumber)).toContain("27018");
  });

  it("leaves a same-prefix code that isn't close to any recalled model alone", async () => {
    expect(await verdict({ title: "Bottle warmer BRZ9999", brand: "Baby Brezza" })).toBe("NO_MATCH_FOUND");
  });

  it("lists a same-maker recall ahead of recalls that only share a kind of product", async () => {
    // Romorgniz's Six-Drawer Dressers read closer to these words, but they're another maker's. SOOWERY's own recall goes first.
    const shown = await checkText(db, { title: "SOOWERY Six-Drawer Dressers Oak", model: "" }, TODAY, { maxResults: 1, mentions: false });
    expect(shown.results[0]?.recallNumber).toBe("27049");
  });

  it("isn't held by a recall from the same maker that the rules cleared or that names another product", () => {
    const empty = { results: [], more: 0, cleared: 0, notJudged: 0, mentioned: { recalls: [], total: 0 }, checked: { recalls: 1, from: null, to: null, yearsMissing: [] }, note: "" };
    expect(readListingCheck({ ...empty, heldByMaker: 0 }, { brand: "Acme" })).toBe("NO_MATCH_FOUND");
    expect(readListingCheck({ ...empty, heldByMaker: 1 }, { brand: "Acme" })).toBe("MAKER_NOT_RULED_OUT");
  });

  it("the same words with no maker can't be told apart, so they aren't clear", async () => {
    expect(await verdict({ title: "Bottle sterilizer dryer", brand: null })).toBe("COULD_NOT_FINISH");
  });

  it("isn't clear while a year of recalls is missing or a near recall went unjudged", () => {
    const clear = { results: [], more: 0, cleared: 0, notJudged: 0, mentioned: { recalls: [], total: 0 }, checked: { recalls: 1, from: null, to: null, yearsMissing: [] }, note: "" };
    expect(readListingCheck(clear, { brand: "Acme" })).toBe("NO_MATCH_FOUND");
    expect(readListingCheck({ ...clear, notJudged: 1 }, { brand: "Acme" })).toBe("COULD_NOT_FINISH");
    expect(readListingCheck({ ...clear, checked: { ...clear.checked, yearsMissing: [2025] } }, { brand: "Acme" })).toBe("COULD_NOT_FINISH");
    expect(readListingCheck({ ...clear, more: 1 }, { brand: "Acme" })).toBe("NAMES_A_RECALL");
  });
});
