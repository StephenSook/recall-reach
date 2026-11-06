import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { channel3Search, CHANNEL3_MCP_URL, MAX_ANSWER_BYTES, MAX_LISTINGS, type SearchMarket } from "./channel3";
import { queryFor, readSweep, SWEEP_PER_RUN, sweepCounts, sweepRecalls } from "./sweep";

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

  it("stops at the first failure, since it may be a limit, and the others go next time", async () => {
    const failing = vi.fn<SearchMarket>(async () => {
      throw new Error("429");
    });
    expect(await sweepRecalls(db, failing, NOW)).toMatchObject({ searched: 0, failed: 1 });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await sweepRecalls(db, async () => found("Back"), NOW, 60)).toMatchObject({ searched: 54, failed: 0, left: 0 });
  });

  it("doesn't let one failing recall hold up the others: it waits a day before trying that one again", async () => {
    const tried: string[] = [];
    const first = (await db.query<{ title: string; products: { name?: string }[] }>("select title, products from recalls order by recall_date desc, recall_number desc limit 1")).rows[0];
    const search: SearchMarket = async (query) => {
      tried.push(query);
      if (query === queryFor(first)) throw new Error("this one fails");
      return found("A title");
    };
    for (let run = 0; run < 3; run++) await sweepRecalls(db, search, new Date(NOW.getTime() + run * 3_600_000), 1);
    expect(tried.filter((q) => q === queryFor(first))).toHaveLength(1);
    expect(tried).toHaveLength(3);
    await sweepRecalls(db, search, new Date(NOW.getTime() + 25 * 3_600_000), 60);
    expect(tried.filter((q) => q === queryFor(first))).toHaveLength(2);
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

  it("counts what it has, leaving out failures", async () => {
    await sweepRecalls(db, async () => found("A", "B"), NOW, 3);
    expect(await sweepCounts(db)).toEqual({ searched: 3, listings: 6 });
    await sweepRecalls(db, async () => Promise.reject(new Error("down")), NOW, 3);
    expect(await sweepCounts(db)).toEqual({ searched: 3, listings: 6 });
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

    const answering = (structuredContent: Record<string, unknown>) =>
      (async (_url: string | URL, init?: RequestInit) => {
        const server = new McpServer({ name: "fake", version: "1.0.0" });
        server.registerTool("search_products", { inputSchema: { query: z.string() } }, async () => ({ content: [{ type: "text" as const, text: "x" }], structuredContent }));
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        return transport.handleRequest(new Request(CHANNEL3_MCP_URL, init));
      }) as typeof fetch;

    it.each(["infinity", "not a time", ""])("doesn't keep %j as a time: it would break the page that reads it", async (asOf) => {
      expect((await channel3Search(answering({ as_of: asOf, products: [] }))("x")).asOf).toBeNull();
    });

    it("keeps a sane number of listings, and drops an id or title that isn't sane", async () => {
      const many = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, title: `Title ${i}`, brands: [] }));
      const { listings } = await channel3Search(answering({ products: [{ id: "x".repeat(4096), title: "Long id", brands: [] }, ...many] }))("x");
      expect(listings).toHaveLength(MAX_LISTINGS);
      expect(listings[0].id).toBe("p0");
    });

    it("reads a streamed answer as it comes, without waiting for the stream to close", async () => {
      const streaming = (async (_url: string | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") !== "POST") return new Response(null, { status: 405 });
        const body = JSON.parse(String(init?.body));
        if (body.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
        }
        if (body.id === undefined) return new Response(new ReadableStream(), { status: 202 }); // a notification: its body never closes
        const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: { products: [{ id: "a", title: "Streamed", brands: [] }] } } });
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${message}\n\n`));
            // Never closes, as a server may keep it open.
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      expect((await channel3Search(streaming, { timeoutMs: 2_000 })("x")).listings[0].title).toBe("Streamed");
    });

    it("gives up on an answer that is too large, rather than holding it all", async () => {
      const huge = { products: [{ id: "a", title: "x".repeat(MAX_ANSWER_BYTES + 1000), brands: [] }] };
      await expect(channel3Search(answering(huge))("x")).rejects.toThrow();
    });

    it("gives up on time however far it got, including on the step after initialize", async () => {
      let posts = 0;
      const stalls = (async (_url: string | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") !== "POST") return new Response(null, { status: 405 });
        posts++;
        if (posts >= 2) return new Promise<Response>(() => {}); // never answers, and ignores the abort
        const server = new McpServer({ name: "fake", version: "1.0.0" });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        return transport.handleRequest(new Request(CHANNEL3_MCP_URL, init));
      }) as typeof fetch;
      const started = Date.now();
      await expect(channel3Search(stalls, { timeoutMs: 200 })("x")).rejects.toThrow("gave up");
      expect(Date.now() - started).toBeLessThan(2_000);
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
