// Channel3's public search, over its MCP server, with no key. It only ever gets a recall's product name from CPSC's public
// record. Nothing from a shop or from PayPal reaches this file: see sweep.ts, which reads only the recalls table.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CHANNEL3_MCP_URL = "https://mcp.trychannel3.com/";
const TIMEOUT_MS = 20_000;

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

/** The fields kept. Offers hold the retailers and prices, and they stop here, so no retailer can be named by mistake. */
function readAnswer(answer: unknown): MarketSearch {
  const content = (answer as { structuredContent?: { products?: unknown; as_of?: unknown } }).structuredContent;
  if (!content || !Array.isArray(content.products)) throw new Error("Channel3 answered without a product list");
  const listings = content.products.flatMap((p: { id?: unknown; title?: unknown; brands?: unknown }) => {
    if (typeof p?.id !== "string" || !p.id || typeof p.title !== "string" || !p.title.trim()) return [];
    const brand = Array.isArray(p.brands) ? (p.brands as { name?: unknown }[]).find((b) => typeof b?.name === "string")?.name : null;
    return [{ id: p.id, title: p.title.trim().slice(0, 300), brand: typeof brand === "string" ? brand.slice(0, 120) : null }];
  });
  return { listings, asOf: typeof content.as_of === "string" ? content.as_of : null };
}

export function channel3Search(fetchImpl: typeof fetch = fetch): SearchMarket {
  return async (query) => {
    const client = new Client({ name: "recall-reach", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(CHANNEL3_MCP_URL), { fetch: fetchImpl });
    await client.connect(transport, { timeout: TIMEOUT_MS });
    try {
      return readAnswer(await client.callTool({ name: "search_products", arguments: { query } }, undefined, { timeout: TIMEOUT_MS }));
    } finally {
      await client.close();
    }
  };
}
