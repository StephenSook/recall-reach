import { beforeEach, describe, expect, it, vi } from "vitest";
const held = vi.hoisted(() => ({ products: [] as unknown[] }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  async connect() {}
  async close() {}
  async callTool() { return { structuredContent: { products: held.products } }; }
} }));
import { channel3Listings } from "./channel3";

describe("the public retailer on site-tool listing results", () => {
  beforeEach(() => {
    held.products = [{ id: "tub", title: "Folding Tub", brands: [{ name: "Acme" }], offers: [
      { availability: "OutOfStock", domain: "gone.example", price: { price: 1, currency: "USD" } },
      { availability: "InStock", domain: "dear.example", price: { price: 40, currency: "USD" } },
      { availability: "InStock", domain: "lowest.example", price: { price: 24.99, currency: "USD" } },
    ] }];
  });
  it("takes the domain from the same in-stock USD offer as the displayed price", async () => {
    expect(await channel3Listings(undefined, { includeRetailer: true }).search("tub")).toEqual([{ id: "tub", title: "Folding Tub", brand: "Acme", priceCents: 2499, currency: "USD", retailer: "lowest.example" }]);
  });
  it("keeps retailers out of the existing shopper and sweep paths", async () => {
    expect((await channel3Listings().search("tub"))[0]).not.toHaveProperty("retailer");
    expect(await channel3Listings(undefined, { includeRetailer: true }).read("tub")).not.toHaveProperty("retailer");
  });
});
