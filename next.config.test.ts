import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

describe("the API docs at /api-docs", () => {
  it("serves each page's own index.html for a folder address, after any real file", async () => {
    const rewrites = await nextConfig.rewrites!();
    const after = Array.isArray(rewrites) ? rewrites : rewrites.afterFiles;
    expect(after).toEqual(expect.arrayContaining([{ source: "/api-docs", destination: "/api-docs/index.html" }, { source: "/api-docs/:path*", destination: "/api-docs/:path*/index.html" }]));
  });
});

describe("response headers", () => {
  it("sends no referrer from a family page: its address is the only key to that page", async () => {
    const rules = await nextConfig.headers!();
    const family = rules.find((r) => r.source === "/r/:token");
    expect(family?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });

  // Every way back from PayPal: a sandbox order, a shop connecting its account (PayPal adds the seller's merchant id), and
  // an owner's sign-in (a one-time code and its state). None of it may sit in a referrer or a request log.
  it.each([
    ["/api/demo/buy/paypal/return", "?state=s&token=ORDER1&PayerID=PAYER1"],
    ["/api/shop/paypal/back", "?merchantId=T&merchantIdInPayPal=SELLERPAYER1&permissionsGranted=true"],
    ["/api/owner/paypal/return", "?code=C21AA-code&state=S"],
    ["/api/shopper/return", "?slip=S&token=ORDER1&PayerID=PAYER1"],
    ["/shopper/done", "?slip=S&token=ORDER1&held=1"],
  ])("keeps PayPal's ids on the way back from %s out of referrers and request logs", async (path, query) => {
    const rules = await nextConfig.headers!();
    const back = rules.find((r) => r.source === path);
    expect(back?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
    const logging = nextConfig.logging;
    const ignored = logging && typeof logging.incomingRequests === "object" ? logging.incomingRequests.ignore : [];
    expect(ignored?.some((pattern) => pattern.test(`${path}${query}`))).toBe(true);
  });
});
