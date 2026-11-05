import { describe, expect, it } from "vitest";
import { clientIp, createRateLimiter } from "./rateLimit";

describe("createRateLimiter", () => {
  it("allows up to the limit within the window, then refuses", () => {
    let now = 0;
    const allow = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    expect(allow("b")).toBe(true);
    now = 1001;
    expect(allow("a")).toBe(true);
  });

  it("forgets old keys, so it cannot grow without bound", () => {
    let now = 0;
    const seen: string[] = [];
    const allow = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now, onSweep: (size) => seen.push(String(size)) });
    for (let i = 0; i < 5; i++) allow(`k${i}`);
    now = 2000;
    allow("later");
    expect(seen).toEqual(["1"]);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded address", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });
  it("has a stable fallback", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
