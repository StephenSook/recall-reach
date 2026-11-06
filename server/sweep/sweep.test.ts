import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { channel3Search, CHANNEL3_MCP_URL, type SearchMarket } from "./channel3";
import { queryFor, readSweep, SWEEP_PER_RUN, sweepRecalls } from "./sweep";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const NOW = new Date("2026-11-06T15:00:00Z");
const found = (...titles: string[]) => ({ listings: titles.map((title, i) => ({ id: `p${i}`, title, brand: "Brand" })), asOf: "2026-11-06T14:59:00.000Z" });

describe("the market sweep", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  it("searches a few at a time, newest first, and says how many are left", async () => {
    const search = vi.fn<SearchMarket>(async () => found("A title"));
    const run = await sweepRecalls(db, search, NOW);
    expect(run).toMatchObject({ searched: SWEEP_PER_RUN, failed: 0 });
    expect(run.left).toBe(55 - SWEEP_PER_RUN);
    expect(search).toHaveBeenCalledTimes(SWEEP_PER_RUN);
    const sweep = await readSweep(db, "27072");
    expect(sweep).toMatchObject({ status: "ok", listings: [{ id: "p0", title: "A title", brand: "Brand" }], recallChanged: false });
  });

  it("sends only CPSC's public product name, even with shop and PayPal rows in the database", async () => {
    const shop = await db.query<{ id: string }>("insert into shops (name, kind) values ('PLANTED-SHOP-NAME', 'REAL') returning id");
    await db.query("insert into shop_items (shop_id, title, listed, source) values ($1, 'PLANTED-ITEM-TITLE', true, 'x')", [shop.rows[0].id]);
    await db.query("insert into paypal_payments (shop_id, order_id, capture_id, items) values ($1, 'PLANTED-ORDER', 'PLANTED-CAPTURE', '[]'::jsonb)", [shop.rows[0].id]);
    const sent: string[] = [];
    await sweepRecalls(db, async (query) => {
      sent.push(query);
      return found();
    }, NOW, 60);
    expect(sent).toHaveLength(55);
    expect(sent.join("\n")).not.toContain("PLANTED");
    const names = await db.query<{ title: string; products: { name?: string }[] }>("select title, products from recalls");
    const allowed = new Set(names.rows.map((r) => queryFor(r)));
    for (const query of sent) expect(allowed.has(query), query).toBe(true);
  });

  it("doesn't search again what it already has, until it is a week old", async () => {
    const search = vi.fn<SearchMarket>(async () => found("A title"));
    await sweepRecalls(db, search, NOW, 60);
    search.mockClear();
    expect((await sweepRecalls(db, search, new Date(NOW.getTime() + 6 * 86_400_000), 60)).searched).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect((await sweepRecalls(db, search, new Date(NOW.getTime() + 8 * 86_400_000), 3)).searched).toBe(3);
  });

  it("stops at the first failure, since it may be a limit, and tries again next time", async () => {
    const failing = vi.fn<SearchMarket>(async () => {
      throw new Error("429");
    });
    expect(await sweepRecalls(db, failing, NOW)).toMatchObject({ searched: 0, failed: 1 });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await sweepRecalls(db, async () => found("Back"), NOW, 60)).toMatchObject({ searched: 55, failed: 0, left: 0 });
    expect((await readSweep(db, "27072"))?.status).toBe("ok");
  });

  it("keeps what it had when a refresh fails", async () => {
    await sweepRecalls(db, async () => found("Kept title"), NOW, 60);
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    await sweepRecalls(db, async () => Promise.reject(new Error("down")), later, 60);
    expect((await readSweep(db, "27072"))?.listings[0].title).toBe("Kept title");
    expect((await readSweep(db, "27072"))?.status).toBe("ok");
  });

  it("says when CPSC has edited the recall since the search", async () => {
    await sweepRecalls(db, async () => found("A title"), NOW, 60);
    await db.query("update recalls set raw_sha256 = 'edited' where recall_number = '27072'");
    expect((await readSweep(db, "27072"))?.recallChanged).toBe(true);
  });

  it("has nothing to say about a recall it hasn't searched", async () => {
    expect(await readSweep(db, "27072")).toBeNull();
  });

  describe("the Channel3 client, against a real MCP server", () => {
    // Shaped as Channel3 answered on 2026-11-05 (research/raw/channel3), with invented products and retailers.
    const fakeChannel3 = (seen: string[]) =>
      (async (_url: string | URL, init?: RequestInit) => {
        const server = new McpServer({ name: "fake", version: "1.0.0" });
        server.registerTool("search_products", { inputSchema: { query: z.string() } }, async ({ query }) => {
          seen.push(query);
          return {
            content: [{ type: "text" as const, text: "Found 2 products" }],
            structuredContent: {
              query,
              as_of: "2026-11-06T14:59:00.000Z",
              products: [
                { id: "abc", title: "  Example Dryer  ", brands: [{ id: "b1", name: "Example Brand" }], images: [{ url: "https://img.example/1.jpg" }], offers: [{ domain: "PLANTED-RETAILER.example", price: { price: 180 }, url: "https://PLANTED-RETAILER.example/p" }] },
                { id: "def", title: "No Brand Dryer", brands: [], offers: [] },
                { id: "", title: "dropped: no id" },
              ],
            },
          };
        });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        return transport.handleRequest(new Request(CHANNEL3_MCP_URL, init));
      }) as typeof fetch;

    it("asks with search_products, and keeps only ids, titles and brands", async () => {
      const seen: string[] = [];
      const answer = await channel3Search(fakeChannel3(seen))("Example dryer");
      expect(seen).toEqual(["Example dryer"]);
      expect(answer).toEqual({
        asOf: "2026-11-06T14:59:00.000Z",
        listings: [
          { id: "abc", title: "Example Dryer", brand: "Example Brand" },
          { id: "def", title: "No Brand Dryer", brand: null },
        ],
      });
      expect(JSON.stringify(answer)).not.toContain("RETAILER");
    });

    it("fails plainly when an answer has no product list", async () => {
      const noList = (async (_url: string | URL, init?: RequestInit) => {
        const server = new McpServer({ name: "fake", version: "1.0.0" });
        server.registerTool("search_products", { inputSchema: { query: z.string() } }, async () => ({ content: [{ type: "text" as const, text: "nothing" }] }));
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        return transport.handleRequest(new Request(CHANNEL3_MCP_URL, init));
      }) as typeof fetch;
      await expect(channel3Search(noList)("x")).rejects.toThrow("product list");
    });
  });
});
