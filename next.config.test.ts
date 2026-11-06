import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

describe("response headers", () => {
  it("sends no referrer from a family page: its address is the only key to that page", async () => {
    const rules = await nextConfig.headers!();
    const family = rules.find((r) => r.source === "/r/:token");
    expect(family?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });
});
