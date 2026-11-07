import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShopPayout } from "@/server/paypal/payouts";
import { PastWindowPayout } from "./PastWindowPayout";

const RECEIVER = "sb@personal.example.com";
const payout = (over: Partial<ShopPayout> = {}): ShopPayout => ({ id: "p1", status: "reviewed", paypalStatus: null, receiver: RECEIVER, amountCents: 2400, currency: "USD", ...over });
const html = (p: ShopPayout | null) => renderToStaticMarkup(createElement(PastWindowPayout, { product: "CheerKid Baby Bath Seats", recalledOn: "2026-02-12", payout: p, receiver: RECEIVER }));

describe("the payment past the refund window", () => {
  it("starts closed and labelled a sample", () => {
    const page = html(null);
    expect(page).toMatch(/^<details/);
    expect(page).not.toMatch(/^<details[^>]* open/);
    expect(page).toContain("A labelled sample, not a sale, and not in any count.");
    expect(page).toContain("Review this payment");
    expect(page).not.toContain("Send this payment");
  });

  it("says plainly that it isn't a refund, why, and where the money comes from", () => {
    const page = html(null);
    expect(page).toContain("CPSC recall 26266: CheerKid Baby Bath Seats. Recalled 2026-02-12. Sold 2026-03-04 for 24.00 USD. PayPal&#x27;s refund window closes after 180 days, so a refund can&#x27;t reach this sale.");
    expect(page).toContain("You can choose to send a separate payment instead. It isn&#x27;t a PayPal refund: it comes out of the shop&#x27;s own PayPal balance, not the original payment. You approve one exact amount, twice. Here it&#x27;s sandbox test money.");
  });

  it("sends only to the demo's sandbox buyer, shown and not typed", () => {
    const page = html(null);
    expect(page).toContain(RECEIVER);
    expect(page).not.toContain('name="email"');
  });

  it("the second approval names the exact amount, where it comes from and the address", () => {
    expect(html(payout())).toContain(`Send 24.00 USD from the shop&#x27;s balance to ${RECEIVER}?`);
  });

  it("never says paid until PayPal does", () => {
    const sent = html(payout({ status: "unconfirmed", paypalStatus: "PENDING" }));
    expect(sent).toContain("It hasn&#x27;t confirmed this yet.");
    expect(sent).not.toContain("was paid");
    expect(html(payout({ status: "paid", paypalStatus: "SUCCESS" }))).toContain("PayPal says this was paid.");
  });

  it("says unclaimed plainly", () => {
    expect(html(payout({ status: "unclaimed", paypalStatus: "UNCLAIMED" }))).toContain("nobody has claimed this yet");
  });

  it("offers to review again only when the payment didn't reach the buyer", () => {
    const failed = html(payout({ status: "failed", paypalStatus: "RETURNED" }));
    expect(failed).toContain("PayPal says this didn&#x27;t reach the buyer.");
    expect(failed).toContain("Review this payment");
    expect(html(payout({ status: "unconfirmed" }))).not.toContain("Review this payment");
  });
});
