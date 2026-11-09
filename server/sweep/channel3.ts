// Channel3's public search, over its MCP server, with no key. It only ever gets a recall's product name from CPSC's public
// record. Nothing from a shop or from PayPal reaches this file: see sweep.ts, which reads only the recalls table.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CHANNEL3_MCP_URL = "https://mcp.trychannel3.com/";
/** For the whole exchange, start to finish. Five of these fit inside what the hourly job has left after its own budget. */
const TIMEOUT_MS = 20_000;
export const MAX_LISTINGS = 20;
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const MAX_ID = 64;

export interface MarketListing {
  id: string;
  title: string;
  brand: string | null;
}

export interface MarketSearch {
  listings: MarketListing[];
  asOf: string | null;
}

export type SearchMarket = (query: string) => Promise<MarketSearch>;

const validTime = (value: unknown): string | null => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);

/** The fields kept. Offers hold the retailers and prices, and they stop here, so no retailer can be named by mistake. */
function readAnswer(answer: unknown): MarketSearch {
  const content = (answer as { structuredContent?: { products?: unknown; as_of?: unknown } }).structuredContent;
  if (!content || !Array.isArray(content.products)) throw new Error("Channel3 answered without a product list");
  const listings = content.products.flatMap((p: { id?: unknown; title?: unknown; brands?: unknown }) => {
    if (typeof p?.id !== "string" || !p.id || p.id.length > MAX_ID || typeof p.title !== "string" || !p.title.trim()) return [];
    const brand = Array.isArray(p.brands) ? (p.brands as { name?: unknown }[]).find((b) => typeof b?.name === "string")?.name : null;
    return [{ id: p.id, title: p.title.trim().slice(0, 300), brand: typeof brand === "string" ? brand.slice(0, 120) : null }];
  });
  return { listings: listings.slice(0, MAX_LISTINGS), asOf: validTime(content.as_of) };
}

/** Passes an answer through as it arrives, and stops it past the size limit. A stream may never close, so nothing waits for its end. */
function sizeLimited(res: Response): Response {
  if (!res.body) return res;
  let seen = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_ANSWER_BYTES) controller.error(new Error("Channel3's answer is too large"));
      else controller.enqueue(chunk);
    },
  });
  return new Response(res.body.pipeThrough(limit), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Every request shares one clock. */
function bounded(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (url, init) => sizeLimited(await fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }));
}

/** One call to Channel3, start to finish, on one clock. */
async function callChannel3<T>(fetchImpl: typeof fetch, timeoutMs: number, name: string, args: Record<string, unknown>, read: (answer: unknown) => T): Promise<T> {
  const stop = new AbortController();
  const client = new Client({ name: "recall-reach", version: "1.0.0" });
  const exchange = async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(CHANNEL3_MCP_URL), { fetch: bounded(fetchImpl, stop.signal) }));
    return read(await client.callTool({ name, arguments: args }));
  };
  // A race, not only the abort: this has to end on time even if something ignores the abort.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up on Channel3 after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([exchange(), late]);
  } finally {
    clearTimeout(timer);
    stop.abort();
    void client.close().catch(() => {});
  }
}

export function channel3Search(fetchImpl: typeof fetch = fetch, opts: { timeoutMs?: number } = {}): SearchMarket {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return (query) => callChannel3(fetchImpl, timeoutMs, "search_products", { query }, readAnswer);
}

/** A listing a buyer could choose, with what the shopping agent's server needs and the model never sees: its price. */
export interface BuyableListing extends MarketListing {
  priceCents: number;
  currency: "USD";
  /** Public offer domain, included only for the site tools. Never kept by the recall sweep. */
  retailer?: string | null;
}

/** The lowest in-stock price in dollars. A listing with none can't be offered. The retailers stop here too. */
function buyable(p: { id?: unknown; title?: unknown; brands?: unknown; offers?: unknown }, includeRetailer = false): BuyableListing | null {
  if (typeof p?.id !== "string" || !p.id || p.id.length > MAX_ID || typeof p.title !== "string" || !p.title.trim()) return null;
  const offers = Array.isArray(p.offers) ? (p.offers as { domain?: unknown; availability?: unknown; price?: { price?: unknown; currency?: unknown } }[]) : [];
  const prices = offers.flatMap((o) => (o?.availability === "InStock" && o.price?.currency === "USD" && typeof o.price.price === "number" && o.price.price > 0 ? [Math.round(o.price.price * 100)] : []));
  if (prices.length === 0) return null;
  const brand = Array.isArray(p.brands) ? (p.brands as { name?: unknown }[]).find((b) => typeof b?.name === "string")?.name : null;
  const priceCents = Math.min(...prices);
  const cheapest = offers.find((o) => o?.availability === "InStock" && o.price?.currency === "USD" && typeof o.price.price === "number" && Math.round(o.price.price * 100) === priceCents);
  return { id: p.id, title: p.title.trim().slice(0, 300), brand: typeof brand === "string" ? brand.slice(0, 120) : null, priceCents, currency: "USD", ...(includeRetailer ? { retailer: typeof cheapest?.domain === "string" ? cheapest.domain.slice(0, 253) : null } : {}) };
}

function readBuyable(answer: unknown, includeRetailer = false): BuyableListing[] {
  const content = (answer as { structuredContent?: { products?: unknown } }).structuredContent;
  if (!content || !Array.isArray(content.products)) throw new Error("Channel3 answered without a product list");
  return content.products.flatMap((p: Parameters<typeof buyable>[0]) => buyable(p, includeRetailer) ?? []).slice(0, MAX_LISTINGS);
}

export interface ListingSource {
  search: (query: string) => Promise<BuyableListing[]>;
  /** Today's listing, read again. Null if it's gone or can't be bought. */
  read: (id: string) => Promise<BuyableListing | null>;
}

export function channel3Listings(fetchImpl: typeof fetch = fetch, opts: { timeoutMs?: number; includeRetailer?: boolean } = {}): ListingSource {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return {
    search: (query) => callChannel3(fetchImpl, timeoutMs, "search_products", { query }, (answer) => readBuyable(answer, opts.includeRetailer)),
    read: (id) => callChannel3(fetchImpl, timeoutMs, "get_products", { product_ids: [id] }, (answer) => readBuyable(answer).find((l) => l.id === id) ?? null),
  };
}
