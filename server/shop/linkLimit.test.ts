import { describe, expect, it } from "vitest";
import { createLinkLimiter, LINK_CHANGES_PER_WINDOW } from "./linkLimit";

describe("how often a shop may check or connect its PayPal account", () => {
  it("allows a few in a row, then waits out the window, one shop at a time", () => {
    let at = 0;
    const allowed = createLinkLimiter({ now: () => at });
    for (let i = 0; i < LINK_CHANGES_PER_WINDOW; i += 1) expect(allowed("shop-a")).toBe(true);
    expect(allowed("shop-a")).toBe(false);
    expect(allowed("shop-b")).toBe(true);
    at += 10 * 60_000 + 1;
    expect(allowed("shop-a")).toBe(true);
  });
});
