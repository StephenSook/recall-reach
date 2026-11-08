import { describe, expect, it } from "vitest";
import { REFUND_SCOPE } from "@/server/paypal/platform";
import { connectPanel } from "./connectPanel";

const STARTED = "2026-11-08T15:00:00.000Z";
const READ = "2026-11-08T15:05:00.000Z";
const READY = { merchantId: "SELLERPAYER1", paymentsReceivable: true, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE] };

describe("the queue's PayPal connection panel", () => {
  it("says plainly when connecting isn't set up on this site, and offers nothing to press", () => {
    expect(connectPanel(null, { setUp: false })).toEqual({ lines: ["Refunds from your own PayPal account aren't set up on this site yet. Notices work now."], actions: [] });
  });

  it("offers to connect, and says PayPal's own page takes the sign-in", () => {
    const p = connectPanel(null, { setUp: true });
    expect(p.actions).toEqual(["connect"]);
    expect(p.lines.join(" ")).toContain("on PayPal's own page");
    expect(p.lines.join(" ")).toContain("You approve each refund here first");
  });

  it("waits on PayPal after the shop starts, and never says connected", () => {
    const p = connectPanel({ trackingId: "t", startedAt: STARTED, status: null, readAt: null, refusal: null, connected: false, salesReadComplete: false }, { setUp: true });
    expect(p.actions).toEqual(["check", "connect", "disconnect"]);
    expect(p.lines.join(" ")).toContain("hasn't said your account is connected");
    expect(p.lines.join(" ")).not.toMatch(/\bConnected\./);
  });

  it("names each thing PayPal said is missing", () => {
    const p = connectPanel({ trackingId: "t", startedAt: STARTED, status: { ...READY, primaryEmailConfirmed: false, scopes: [] }, readAt: READ, refusal: null, connected: false, salesReadComplete: false }, { setUp: true });
    const text = p.lines.join(" ");
    expect(text).toContain("the account's email isn't confirmed");
    expect(text).toContain("refunds weren't granted to this site");
    expect(text).not.toContain("payments can't be received");
  });

  it("says connected only with PayPal's answer behind it, and when it was read", () => {
    const p = connectPanel({ trackingId: "t", startedAt: STARTED, status: READY, readAt: READ, refusal: null, connected: true, salesReadComplete: false }, { setUp: true });
    expect(p.actions).toEqual(["check", "disconnect"]);
    expect(p.lines[0]).toMatch(/^Connected\. PayPal said, .* ET, that payments can be received, the account's email is confirmed and refunds were granted to this site\.$/);
  });

  it("shows PayPal's own words when it refused", () => {
    const p = connectPanel({ trackingId: "t", startedAt: STARTED, status: null, readAt: null, refusal: "PayPal answered HTTP 422, FEATURES_UNAUTHORIZED (PayPal-Debug-Id f1)", connected: false, salesReadComplete: false }, { setUp: true });
    expect(p.lines).toContain("PayPal's answer: PayPal answered HTTP 422, FEATURES_UNAUTHORIZED (PayPal-Debug-Id f1)");
  });
});
