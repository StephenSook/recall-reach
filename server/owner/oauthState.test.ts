import { describe, expect, it } from "vitest";
import { OWNER_STATE_MS, readOwnerState, startOwnerState } from "./oauthState";

const SECRET = "s".repeat(64);
const NOW = new Date("2026-11-08T12:00:00Z");

describe("the state a PayPal sign-in carries", () => {
  it("comes back as the intent it started with, once, for the state PayPal echoes", () => {
    const link = startOwnerState(SECRET, { kind: "link", shopId: "11111111-1111-4111-8111-111111111111" }, NOW);
    expect(readOwnerState(SECRET, link.cookie, link.state, NOW)).toEqual({ kind: "link", shopId: "11111111-1111-4111-8111-111111111111" });
    const signIn = startOwnerState(SECRET, { kind: "signin" }, NOW);
    expect(readOwnerState(SECRET, signIn.cookie, signIn.state, NOW)).toEqual({ kind: "signin" });
  });

  it("makes a fresh state every time", () => {
    expect(startOwnerState(SECRET, { kind: "signin" }, NOW).state).not.toBe(startOwnerState(SECRET, { kind: "signin" }, NOW).state);
  });

  it("refuses a state PayPal didn't echo, a cookie from another sign-in, a changed cookie, or one that's run out", () => {
    const a = startOwnerState(SECRET, { kind: "link", shopId: "11111111-1111-4111-8111-111111111111" }, NOW);
    const b = startOwnerState(SECRET, { kind: "signin" }, NOW);
    expect(readOwnerState(SECRET, a.cookie, b.state, NOW)).toBeNull();
    expect(readOwnerState(SECRET, a.cookie, "", NOW)).toBeNull();
    expect(readOwnerState(SECRET, undefined, a.state, NOW)).toBeNull();
    expect(readOwnerState(SECRET, a.cookie.replace("link", "signin"), a.state, NOW)).toBeNull();
    expect(readOwnerState(SECRET, a.cookie.replace("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"), a.state, NOW)).toBeNull();
    expect(readOwnerState("t".repeat(64), a.cookie, a.state, NOW)).toBeNull();
    expect(readOwnerState(SECRET, a.cookie, a.state, new Date(NOW.getTime() + OWNER_STATE_MS + 1))).toBeNull();
  });
});
