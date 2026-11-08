import { describe, expect, it } from "vitest";
import { createReceiptLimiter } from "./limit";

describe("safety receipt form limits", () => {
  it("limits each visitor across shops and lets the window expire", () => {
    let now = 0;
    const allowed = createReceiptLimiter({ now: () => now });
    const headers = new Headers({ "true-client-ip": "192.0.2.1" });
    for (let i = 0; i < 5; i++) expect(allowed(headers)).toBe(true);
    expect(allowed(headers)).toBe(false);
    expect(allowed(new Headers({ "true-client-ip": "192.0.2.2" }))).toBe(true);
    now = 3_600_001;
    expect(allowed(headers)).toBe(true);
  });

  it("limits everyone together, even with a different visitor each time", () => {
    const allowed = createReceiptLimiter({ now: () => 0 });
    for (let i = 0; i < 200; i++) expect(allowed(new Headers({ "true-client-ip": `192.0.2.${i}` }))).toBe(true);
    expect(allowed(new Headers({ "true-client-ip": "192.0.2.201" }))).toBe(false);
  });
});
