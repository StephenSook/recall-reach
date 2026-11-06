import { describe, expect, it } from "vitest";
import { readSession, sessionCookie } from "./session";

const SECRET = "s".repeat(32);
const SHOP = "00000000-0000-4000-8000-00000000000a";

describe("shop session", () => {
  it("round-trips the shop and a session id", () => {
    const { value, sessionId } = sessionCookie(SECRET, SHOP);
    expect(readSession(SECRET, value)).toEqual({ shopId: SHOP, sessionId });
    expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives every session its own id", () => {
    expect(sessionCookie(SECRET, SHOP).sessionId).not.toBe(sessionCookie(SECRET, SHOP).sessionId);
  });

  it("refuses a changed shop, a changed signature, another secret, and rubbish", () => {
    const { value } = sessionCookie(SECRET, SHOP);
    expect(readSession(SECRET, value.replace(SHOP, "00000000-0000-4000-8000-00000000000b"))).toBeNull();
    expect(readSession(SECRET, `${value.slice(0, -2)}xx`)).toBeNull();
    expect(readSession("z".repeat(32), value)).toBeNull();
    expect(readSession(SECRET, "rubbish")).toBeNull();
    expect(readSession(SECRET, undefined)).toBeNull();
  });

  it("refuses a secret shorter than 32 characters", () => {
    expect(() => sessionCookie("short", SHOP)).toThrow(/32/);
  });

  describe("expiry", () => {
    const AT = new Date("2026-11-06T12:00:00Z");
    const later = (hours: number) => new Date(AT.getTime() + hours * 3_600_000);

    it("holds for a day", () => {
      const { value } = sessionCookie(SECRET, "shop-1", AT);
      expect(readSession(SECRET, value, later(23))).toMatchObject({ shopId: "shop-1" });
    });

    it("ends after a day, even for a copied cookie the browser would have dropped", () => {
      const { value } = sessionCookie(SECRET, "shop-1", AT);
      expect(readSession(SECRET, value, later(25))).toBeNull();
    });

    it("cannot be extended by changing the date", () => {
      const { value } = sessionCookie(SECRET, "shop-1", AT);
      const parts = value.split(".");
      parts[2] = String(later(1000).getTime());
      expect(readSession(SECRET, parts.join("."), later(25))).toBeNull();
    });

    it("refuses an old cookie with no date", () => {
      const { value } = sessionCookie(SECRET, "shop-1", AT);
      const [shopId, sessionId, , signature] = value.split(".");
      expect(readSession(SECRET, `${shopId}.${sessionId}.${signature}`, AT)).toBeNull();
    });
  });
});
