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

describe("createRateLimiter under pressure", () => {
  it("does not let the sweep hand the calling key a new quota", () => {
    let now = 0;
    const allow = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    now = 600;
    expect(allow("a")).toBe(true);
    now = 1100; // the sweep runs on this call, with "a" hit 500 ago
    expect(allow("a")).toBe(false);
  });

  it("keeps the map bounded inside the window, dropping the oldest key first", () => {
    const now = 0;
    const sizes: number[] = [];
    const allow = createRateLimiter({ limit: 1, windowMs: 1_000_000, now: () => now, maxKeys: 3, onSize: (n) => sizes.push(n) });
    for (const key of ["a", "b", "c", "d", "e"]) expect(allow(key)).toBe(true);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    expect(allow("e")).toBe(false); // still remembered
    expect(allow("a")).toBe(true); // dropped first
  });
});

describe("clientIp", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("reads the address Cloudflare sets, which a caller cannot forge (measured on Render, 2026-11-06)", () => {
    expect(clientIp(headers({ "true-client-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.99, 198.51.100.7, 10.0.0.1" }), true)).toBe("198.51.100.7");
  });

  it("ignores a forged x-forwarded-for: its left value is whatever the caller sent", () => {
    const a = clientIp(headers({ "true-client-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.1" }), true);
    const b = clientIp(headers({ "true-client-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.2" }), true);
    expect(a).toBe(b);
  });

  it("treats one IPv6 network as one visitor: a single home can hold countless addresses", () => {
    const of = (ip: string) => clientIp(headers({ "true-client-ip": ip }), true);
    expect(of("2001:db8:1:2:aaaa::1")).toBe(of("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
    expect(of("2001:db8:1:2::1")).toBe(of("2001:0db8:0001:0002:0000:0000:0000:0002"));
    expect(of("2001:db8:1:2::1")).not.toBe(of("2001:db8:1:3::1"));
  });

  it("treats an IPv4 address the same however it is written", () => {
    expect(clientIp(headers({ "true-client-ip": "::ffff:198.51.100.7" }), true)).toBe("198.51.100.7");
  });

  it("gives no answer for a value that is not an address", () => {
    expect(clientIp(headers({ "true-client-ip": "not an address" }), true)).toBeNull();
    expect(clientIp(headers({ "true-client-ip": "198.51.100.7, 203.0.113.1" }), true)).toBeNull();
  });

  it("gives no answer on the host when the header is missing, rather than one shared bucket", () => {
    expect(clientIp(headers({}), true)).toBeNull();
  });

  it("uses one local key off the host, where there is no proxy", () => {
    expect(clientIp(headers({}), false)).toBe("local");
  });
});
