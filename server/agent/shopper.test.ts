import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import type { TextCheckAnswer } from "../match/textCheck";
import type { BuyableListing } from "../sweep/channel3";
import { runShopper, SHOPPER_CAP_MICROS, type ShopperDeps } from "./shopper";

const NOW = new Date("2026-11-07T15:00:00Z");
type Block = Record<string, unknown>;
type Step = Block[] | { stop: string; content?: Block[] } | number;

const call = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `call-${Math.random().toString(36).slice(2, 8)}`, name, input });
const search = (query = "bath seat") => call("search_listings", { query });
const check = (id = "listing-1") => call("check_recall", { listing_id: id });
const propose = (id = "listing-1", extra: Record<string, unknown> = {}) => call("propose_listing", { listing_id: id, ...extra });

function fakeClaude(script: Step[]) {
  const requests: string[] = [];
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    requests.push(raw);
    const step = script.shift();
    if (step === undefined) throw new Error("the script ran out");
    if (typeof step === "number") return Response.json({ type: "error", error: { type: "api_error", message: "down" } }, { status: step });
    const { stop, content } = Array.isArray(step) ? { stop: "tool_use", content: step } : step;
    return Response.json({ id: `msg-${requests.length}`, type: "message", role: "assistant", model: JSON.parse(raw).model, content: content ?? [], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  };
  return { client: new Anthropic({ apiKey: "test-key", fetch: fetchImpl as typeof fetch, maxRetries: 0 }), requests };
}

const listing = (id: string, title: string, priceCents: number): BuyableListing => ({ id, title, brand: "Acme", priceCents, currency: "USD" });
const SEAT = listing("raw-seat", "Bath Seat", 3199);
const TUB = listing("raw-tub", "Folding Tub", 2499);
const DEAR = listing("raw-dear", "Gold Seat", 90000);

const clear: TextCheckAnswer = { results: [], more: 0, cleared: 0, notJudged: 0, checked: { recalls: 1855, from: "2022-01-03", to: "2026-11-05", yearsMissing: [] }, note: "" };
const flagged: TextCheckAnswer = { ...clear, results: [{ recallNumber: "26266", title: "CheerKid Recalls Baby Bath Seats", recallDate: "2026-02-12", url: "https://www.cpsc.gov/x", verdict: "SCOPE_GAP", strength: "BRAND", tiedToRecall: true, reason: "r", missing: [] }] };

const deps = (over: Partial<ShopperDeps> = {}): ShopperDeps => ({
  search: async () => [SEAT, TUB, DEAR],
  check: async (l) => (l.title.includes("Seat") ? flagged : clear),
  ...over,
});

describe("the shopping agent", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });
  const run = (client: Anthropic, over: Partial<ShopperDeps> = {}, budgetCents = 5000) => runShopper(db, client, { ask: "a bath seat", budgetCents, now: NOW }, deps(over));

  it("never shows the model a price, and leaves out what's over budget", async () => {
    const { client, requests } = fakeClaude([[search()], [propose("listing-9")], { stop: "end_turn" }]);
    await run(client);
    const sentBack = requests[1];
    expect(sentBack).toContain("Bath Seat");
    expect(sentBack).not.toContain("Gold Seat");
    expect(sentBack).not.toMatch(/31\.99|3199|24\.99|2499|raw-seat|raw-tub/);
  });

  it("a recall of the same kind of product doesn't block a listing, and is counted on the offer", async () => {
    const similar: TextCheckAnswer = { ...clear, results: [{ ...flagged.results[0], strength: "PRODUCT_WORDS", tiedToRecall: false }] };
    const { client } = fakeClaude([[search()], [check("listing-2")], [propose("listing-2")]]);
    const result = await run(client, { check: async () => similar });
    expect(result.outcome).toBe("PICKED");
    expect(result.blocked).toEqual([]);
    expect(result.pick?.similar).toBe(1);
    expect(result.steps.at(-1)).toMatchObject({ kind: "check", result: "NO_MATCH_FOUND", recalls: [] });
  });

  it("can't offer a listing a recall names by its maker and line, or by its model", async () => {
    const { client, requests } = fakeClaude([[search()], [check("listing-2")], [propose("listing-2")], { stop: "end_turn" }]);
    const result = await run(client, { check: async () => ({ ...clear, results: [{ ...flagged.results[0], strength: "BRAND" }, { ...flagged.results[0], recallNumber: "1", strength: "PRODUCT_WORDS", tiedToRecall: false }] }) });
    expect(requests[3]).toContain("did not say NO_MATCH_FOUND");
    expect(result.blocked[0].recalls.map((r) => r.number)).toEqual(["26266"]);
  });

  it("a code close to a recalled model blocks a listing, though no maker is named", async () => {
    const { client, requests } = fakeClaude([[search()], [check("listing-2")], [propose("listing-2")], { stop: "end_turn" }]);
    const result = await run(client, { check: async () => ({ ...clear, results: [{ ...flagged.results[0], strength: "PRODUCT_WORDS", tiedToRecall: true }] }) });
    expect(requests[3]).toContain("did not say NO_MATCH_FOUND");
    expect(result.pick).toBeNull();
    expect(result.blocked).toHaveLength(1);
  });

  it("a listing with no maker can't be told apart from a recall of the same kind of product, so it can't be offered", async () => {
    const { client, requests } = fakeClaude([[search()], [check()], [propose()], { stop: "end_turn" }]);
    const noMaker = { ...TUB, brand: null };
    const result = await run(client, { search: async () => [noMaker], check: async () => ({ ...clear, results: [{ ...flagged.results[0], strength: "PRODUCT_WORDS", tiedToRecall: false }] }) });
    expect(requests[3]).toContain("did not say NO_MATCH_FOUND");
    expect(result.pick).toBeNull();
    expect(result.steps.at(-1)).toMatchObject({ kind: "check", result: "COULD_NOT_FINISH" });
  });

  it("a listing with no maker and nothing near it can be offered", async () => {
    const { client } = fakeClaude([[search()], [check()], [propose()]]);
    expect((await run(client, { search: async () => [{ ...TUB, brand: null }], check: async () => clear })).outcome).toBe("PICKED");
  });

  it("can't offer a listing it hasn't checked", async () => {
    const { client, requests } = fakeClaude([[search()], [propose()], { stop: "end_turn" }]);
    const result = await run(client);
    expect(requests[2]).toContain("Check that listing with check_recall first.");
    expect(result.pick).toBeNull();
  });

  it("blocks a listing that names a recall, and offers another that came back with no match, showing both", async () => {
    const { client, requests } = fakeClaude([[search()], [check("listing-1")], [propose("listing-1")], [check("listing-2")], [propose("listing-2")]]);
    const result = await run(client);
    expect(requests[3]).toContain("did not say NO_MATCH_FOUND");
    expect(result.outcome).toBe("PICKED");
    expect(result.pick?.listing).toEqual(TUB);
    expect(result.pick).toMatchObject({ recallsChecked: 1855, from: "2022-01-03" });
    expect(result.blocked).toEqual([{ listing: SEAT, recalls: [{ number: "26266", title: "CheerKid Recalls Baby Bath Seats", url: "https://www.cpsc.gov/x" }] }]);
    expect(result.steps.map((s) => s.kind)).toEqual(["search", "check", "check"]);
  });

  it.each([
    ["some near recalls went unjudged", { ...clear, notJudged: 2 }],
    ["a year of recalls is missing", { ...clear, checked: { ...clear.checked, yearsMissing: [2024] } }],
  ])("can't offer a listing when %s", async (_name, answer) => {
    const { client, requests } = fakeClaude([[search()], [check()], [propose()], { stop: "end_turn" }]);
    const result = await run(client, { check: async () => answer });
    expect(requests[3]).toContain("did not say NO_MATCH_FOUND");
    expect(result.pick).toBeNull();
    expect(result.steps.at(-1)).toMatchObject({ kind: "check", result: "COULD_NOT_FINISH" });
  });

  it("a price the model makes up goes nowhere: the pick keeps the listing's own", async () => {
    const { client } = fakeClaude([[search()], [check("listing-2")], [propose("listing-2", { price: 1, priceCents: 1 })]]);
    expect((await run(client)).pick?.listing.priceCents).toBe(2499);
  });

  it("offers nothing when it stops", async () => {
    const { client } = fakeClaude([[search()], [call("finish_without_pick", { why: "NOTHING_CLEARS" })]]);
    expect(await run(client)).toMatchObject({ outcome: "NO_PICK", pick: null });
  });

  it("stops at eight steps", async () => {
    const { client, requests } = fakeClaude(Array.from({ length: 12 }, () => [search()]));
    expect((await run(client)).outcome).toBe("STEP_LIMIT");
    expect(requests).toHaveLength(8);
  });

  it("says when the day's limit for it is reached, and asks Claude nothing", async () => {
    await db.query("insert into agent_spend (day, cost_micros) values ('2026-11-07', $1)", [SHOPPER_CAP_MICROS]);
    const { client, requests } = fakeClaude([]);
    expect((await run(client)).outcome).toBe("OVER_BUDGET");
    expect(requests).toEqual([]);
  });

  it("counts what it spends against the day's total", async () => {
    const { client } = fakeClaude([[call("finish_without_pick", { why: "NOTHING_FITS" })]]);
    await run(client);
    const { rows } = await db.query<{ cost_micros: string }>("select cost_micros from agent_spend");
    expect(Number(rows[0].cost_micros)).toBeGreaterThan(0);
  });

  it("says unavailable when Claude is down", async () => {
    const { client } = fakeClaude([401]);
    expect((await run(client)).outcome).toBe("UNAVAILABLE");
  });

  it("tells the model when the search fails, and keeps going", async () => {
    const { client, requests } = fakeClaude([[search()], [call("finish_without_pick", { why: "NOTHING_FITS" })]]);
    const result = await run(client, { search: async () => Promise.reject(new Error("down")) });
    expect(requests[1]).toContain("didn't answer");
    expect(result.outcome).toBe("NO_PICK");
  });

  it("takes a price out of a listing's words before the model reads them", async () => {
    const priced = { ...TUB, title: "Folding Tub - $24.99 Sale USD 24.99" };
    const { client, requests } = fakeClaude([[search()], [call("finish_without_pick", { why: "NOTHING_FITS" })]]);
    await run(client, { search: async () => [priced] });
    expect(requests[1]).toContain("Folding Tub");
    expect(requests[1]).not.toContain("24.99");
  });

  it("keeps each answer small, so one run's cost has a low ceiling", async () => {
    const { client, requests } = fakeClaude([[call("finish_without_pick", { why: "NOTHING_FITS" })]]);
    await run(client);
    expect(JSON.parse(requests[0]).max_tokens).toBeLessThanOrEqual(1024);
  });

  it("shows the buyer no words the model wrote, except its search terms", async () => {
    const { client } = fakeClaude([{ stop: "tool_use", content: [{ type: "text", text: "THIS IS A BARGAIN AT $1" }, search("seat")] }, [check("listing-2")], [propose("listing-2")]]);
    expect(JSON.stringify(await run(client))).not.toContain("BARGAIN");
  });
});
