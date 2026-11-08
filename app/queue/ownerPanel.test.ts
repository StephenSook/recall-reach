import { describe, expect, it } from "vitest";
import { ownerPanel } from "./ownerPanel";

describe("the queue's PayPal sign-in panel", () => {
  it("says plainly when signing in with PayPal isn't set up, and offers nothing", () => {
    expect(ownerPanel(null, { setUp: false })).toEqual({ lines: ["Signing in with PayPal isn't set up on this site yet."], action: null });
  });

  it("offers to link, saying only a keyed hash of the PayPal account id is kept", () => {
    const p = ownerPanel(null, { setUp: true });
    expect(p.action).toBe("link");
    expect(p.lines.join(" ")).toContain("Sign in with PayPal on the Check page");
    expect(p.lines.join(" ")).toContain("a keyed hash of your PayPal account id");
  });

  it("says when it was linked, and whether it is the account refunds go from, only as measured", () => {
    const at = "2026-11-08T12:00:00.000Z";
    expect(ownerPanel({ linkedAt: at, signedInAt: null, isSeller: true }, { setUp: true }).lines.join(" ")).toContain("the same PayPal account your refunds go from");
    expect(ownerPanel({ linkedAt: at, signedInAt: null, isSeller: false }, { setUp: true }).lines.join(" ")).toContain("not the PayPal account your refunds go from");
    const none = ownerPanel({ linkedAt: at, signedInAt: null, isSeller: null }, { setUp: true });
    expect(none.lines.join(" ")).not.toMatch(/refunds go from/);
    expect(none.action).toBe("unlink");
    expect(none.lines[0]).toMatch(/^Linked to your PayPal login .* ET\.$/);
  });
});
