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
});
