import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TextCheckAnswer } from "@/server/match/textCheck";
import { PAYPAL_OPENED, registerShopperTools, type ShopperTool } from "@/app/shopper/webmcp";

const paths = vi.hoisted(() => ({ search: vi.fn(), check: vi.fn(), slip: vi.fn(), start: vi.fn() }));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/sweep/channel3", () => ({ channel3Listings: () => ({ search: paths.search, read: vi.fn() }) }));
vi.mock("@/server/match/textCheck", async (original) => ({ ...(await original<typeof import("@/server/match/textCheck")>()), checkListing: paths.check }));
vi.mock("@/server/paypal/client", () => ({ payPalClientFromEnv: () => ({}) }));
vi.mock("@/server/privacy/recordKey", () => ({ recordKeyFromEnv: () => () => "hash" }));
vi.mock("@/server/paypal/shopperOrder", async (original) => ({ ...(await original<typeof import("@/server/paypal/shopperOrder")>()), createSlip: paths.slip, startShopperOrder: paths.start }));

import { GET } from "./route";
import { POST as buy } from "../buy/route";
import { SlipRefused } from "@/server/paypal/shopperOrder";

const ORIGIN = "http://localhost:3000";
const listing = { id: "clikk", title: "Stokke Clikk High Chair", brand: "Stokke", priceCents: 2499, currency: "USD", retailer: "store.example" };
const clear: TextCheckAnswer = { results: [], more: 0, cleared: 0, notJudged: 0, mentioned: { recalls: [], total: 0 }, checked: { recalls: 1855, from: "2022-01-03", to: "2026-11-05", yearsMissing: [] }, note: "" };
const flagged: TextCheckAnswer = { ...clear, results: [{ recallNumber: "22113", title: "Stokke Recalls Clikk High Chairs Due to Fall and Injury Hazards", recallDate: "2022-04-07", url: null, verdict: "SCOPE_GAP", strength: "BRAND", tiedToRecall: true, sharesWords: false, reason: "A recall names this maker and product line.", missing: [] }] };
let visitor = 0;
const request = (params = "query=chair&maxPrice=50", headers: Record<string, string> = {}, ip = `10.1.0.${++visitor}`) => new Request(`${ORIGIN}/api/shopper/listings?${params}`, { headers: { origin: ORIGIN, "true-client-ip": ip, ...headers } });
const buying = () => new Request(`${ORIGIN}/api/shopper/buy`, { method: "POST", headers: { origin: ORIGIN, "true-client-ip": `10.2.0.${++visitor}`, accept: "application/json" }, body: new URLSearchParams({ slip: "slip-1" }) });

describe("WebMCP listing search and the existing buy route", () => {
  beforeEach(() => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    Object.values(paths).forEach((fn) => fn.mockReset());
    paths.search.mockResolvedValue([listing]);
    paths.check.mockResolvedValue(clear);
    paths.slip.mockResolvedValue({ id: "slip-1" });
  });

  it("checks every in-budget listing and issues slips only for NO_MATCH_FOUND", async () => {
    paths.search.mockResolvedValue([listing, { ...listing, id: "tub", title: "Folding Tub" }, { ...listing, id: "dear", priceCents: 99999 }]);
    paths.check.mockResolvedValueOnce(flagged).mockResolvedValueOnce(clear);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ offerable: [{ id: "tub", price: 24.99, retailer: "store.example", slipId: "slip-1" }], refused: [{ id: "clikk", recallNumber: "22113", recallTitle: flagged.results[0].title }] });
    expect(paths.check).toHaveBeenCalledTimes(2);
    expect(paths.slip).toHaveBeenCalledOnce();
  });

  it("fails closed when coverage is incomplete, a maker can't be ruled out, or the check fails", async () => {
    for (const answer of [{ ...clear, notJudged: 1 }, { ...clear, checked: { ...clear.checked, yearsMissing: [2023] } }, { ...clear, heldByMaker: 1 }]) {
      paths.check.mockResolvedValueOnce(answer);
      expect((await (await GET(request())).json()).offerable).toEqual([]);
    }
    paths.check.mockRejectedValueOnce(new Error("private internals"));
    expect((await GET(request())).status).toBe(503);
    expect(paths.slip).not.toHaveBeenCalled();
  });

  it("requires the same origin, including a browser GET's same-origin referer", async () => {
    for (const origin of ["https://other.example", "null", ""]) expect((await GET(request(undefined, { origin }))).status).toBe(403);
    const browserGet = request(undefined, { "sec-fetch-site": "same-origin", referer: `${ORIGIN}/shopper` });
    browserGet.headers.delete("origin");
    expect((await GET(browserGet)).status).toBe(200);
    const crossOrigin = request(undefined, { origin: "https://other.example", "sec-fetch-site": "same-origin", referer: `${ORIGIN}/shopper` });
    expect((await GET(crossOrigin)).status).toBe(403);
  });

  it.each(["query=x", "query=chair&maxPrice=0", "query=chair&maxPrice=2001", "query=chair&maxPrice=NaN"])("refuses invalid input %s before any source call", async (params) => {
    expect((await GET(request(params))).status).toBe(400);
    expect(paths.search).not.toHaveBeenCalled();
  });

  it("limits each visitor to five searches an hour", async () => {
    const ip = `10.3.0.${++visitor}`;
    for (let n = 0; n < 5; n++) expect((await GET(request(undefined, {}, ip))).status).toBe(200);
    expect((await GET(request(undefined, {}, ip))).status).toBe(429);
    expect(paths.search).toHaveBeenCalledTimes(5);
  });

  it("refuses a hosted request with no trusted visitor address before searching", async () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", ORIGIN);
    const req = request();
    req.headers.delete("true-client-ip");
    expect((await GET(req)).status).toBe(429);
    expect(paths.search).not.toHaveBeenCalled();
  });

  it("keeps JSON checkout under the existing origin check and ten-per-visitor limit", async () => {
    const wrong = buying();
    wrong.headers.set("origin", "https://other.example");
    expect((await buy(wrong)).status).toBe(403);
    expect(paths.start).not.toHaveBeenCalled();
    paths.start.mockResolvedValue({ approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=FAKE" });
    const ip = `10.5.0.${++visitor}`;
    for (let i = 0; i < 10; i++) {
      const req = buying();
      req.headers.set("true-client-ip", ip);
      expect((await buy(req)).status).toBe(200);
    }
    const req = buying();
    req.headers.set("true-client-ip", ip);
    expect((await buy(req)).status).toBe(429);
    expect(paths.start).toHaveBeenCalledTimes(10);
  });

  it("passes the real recall check into startShopperOrder and returns CPSC-only refusal details", async () => {
    paths.check.mockResolvedValue(flagged);
    paths.start.mockImplementation(async (_db, _client, _input, deps) => {
      await deps.check(listing);
      throw new SlipRefused("NOW_FLAGGED", "PLANTED-PAYPAL-SECRET");
    });
    const res = await buy(buying());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ refused: true, recalls: [{ recallNumber: "22113", title: flagged.results[0].title }] });
    expect(paths.check).toHaveBeenCalledWith({}, listing, expect.any(String));
  });

  it("mocked startShopperOrder's PayPal order, URL, payer and amount never reach ANY tool result or log", async () => {
    const url = "https://www.sandbox.paypal.com/checkoutnow?token=PLANTED-ORDER";
    paths.start.mockResolvedValue({ approveUrl: url, orderId: "PLANTED-ORDER", payer: "PLANTED-PAYER", amount: "PLANTED-AMOUNT" });
    const tools: ShopperTool[] = [];
    const logs: unknown[] = [];
    const replace = vi.fn();
    registerShopperTools({ modelContext: { registerTool: async (tool) => { tools.push(tool); } } }, {
      fetch: (async (path, init) => String(path).startsWith("/api/shopper/listings") ? GET(request()) : buy(new Request(`${ORIGIN}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: ORIGIN, "true-client-ip": `10.4.0.${++visitor}` } }))) as typeof fetch,
      open: () => ({ location: { replace }, close: vi.fn(), opener: null }),
      onCall: (call) => logs.push(call),
    });
    const options = { signal: new AbortController().signal };
    const results = [await tools[0].execute({ query: "chair", maxPrice: 50 }, options), await tools[2].execute({ listingId: "clikk" }, options)];
    expect(results[1]).toBe(PAYPAL_OPENED);
    expect(paths.start).toHaveBeenCalledOnce();
    expect(paths.start.mock.calls[0][2]).toMatchObject({ slipId: "slip-1" });
    expect(replace).toHaveBeenCalledWith(url);
    for (const value of [url, "PLANTED-ORDER", "PLANTED-PAYER", "PLANTED-AMOUNT"]) expect(JSON.stringify({ results, logs })).not.toContain(value);
  });
});
