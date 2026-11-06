import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

describe("response headers", () => {
  it("sends no referrer from a family page: its address is the only key to that page", async () => {
    const rules = await nextConfig.headers!();
    const family = rules.find((r) => r.source === "/r/:token");
    expect(family?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });

  it("keeps PayPal's ids on the way back out of referrers and request logs", async () => {
    const rules = await nextConfig.headers!();
    const back = rules.find((r) => r.source === "/api/demo/buy/paypal/return");
    expect(back?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
    const logging = nextConfig.logging;
    const ignored = logging && typeof logging.incomingRequests === "object" ? logging.incomingRequests.ignore : [];
    expect(ignored?.some((pattern) => pattern.test("/api/demo/buy/paypal/return?state=s&token=ORDER1&PayerID=PAYER1"))).toBe(true);
  });
});
