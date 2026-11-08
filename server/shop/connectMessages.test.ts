import { describe, expect, it } from "vitest";
import { refreshedMessage } from "./connectMessages";

describe("what the queue says after connecting", () => {
  it("says connected only with what PayPal's read found, and PayPal's own words otherwise", () => {
    expect(refreshedMessage({ state: "CONNECTED", sales: { complete: true, payments: 8 } })).toBe("Your PayPal account is connected. 8 payments were read from it and joined to your order file.");
    expect(refreshedMessage({ state: "CONNECTED", sales: { complete: false, payments: 2 } })).toContain("didn't answer for all of its sales");
    expect(refreshedMessage({ state: "CONNECTED", sales: { refusal: "PayPal answered HTTP 403, NOT_AUTHORIZED (PayPal-Debug-Id d1)" } })).toBe(
      "Your PayPal account is connected, but its sales couldn't be read, so refunds stay notice-only. PayPal answered HTTP 403, NOT_AUTHORIZED (PayPal-Debug-Id d1)",
    );
    expect(refreshedMessage({ state: "WAITING" })).toContain("hasn't finished");
    expect(refreshedMessage({ state: "REFUSED", refusal: "PayPal answered HTTP 500" })).toContain("PayPal answered HTTP 500");
  });
});
