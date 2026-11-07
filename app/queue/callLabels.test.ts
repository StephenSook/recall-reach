import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { callDocs, callThrough } from "./callLabels";
import { PayPalCalls } from "./PayPalCalls";

const call = (over = {}) => ({ method: "GET", template: "/v2/payments/captures/:id", status: 200, ms: 120, debugId: "dbg123", ...over });
const html = (calls: ReturnType<typeof call>[]) => renderToStaticMarkup(createElement(PayPalCalls, { calls }));

describe("the PayPal call panel", () => {
  it("names what carried each call", () => {
    expect(callThrough({ method: "POST", template: "/v2/payments/captures/:id/refund" })).toBe("Agent Toolkit");
    expect(callThrough({ method: "GET", template: "/v2/payments/refunds/:id" })).toBe("Server SDK");
    expect(callThrough({ method: "GET", template: "/v2/payments/captures/:id" })).toBe("REST");
    expect(callThrough({ method: "POST", template: "/v2/checkout/orders" })).toBe("REST");
  });

  it.each([
    ["/v2/checkout/orders/:id/capture", "/orders/v2/"],
    ["/v2/payments/captures/:id/refund", "/payments/v2/"],
    ["/v2/payments/refunds/:id", "/payments/v2/"],
    ["/v1/reporting/transactions", "/transaction-search/v1/"],
    ["/v1/customer/disputes", "/customer-disputes/v1/"],
  ])("links %s to PayPal's page for it", (template, page) => {
    expect(callDocs(template)).toBe(`https://developer.paypal.com/docs/api${page}`);
  });

  it("gives no link for a call it doesn't know", () => {
    expect(callDocs("/v9/other")).toBeNull();
  });

  it("is nothing when there are no calls", () => {
    expect(html([])).toBe("");
  });

  it("starts closed, and shows each row's shape and debug id", () => {
    const page = html([call()]);
    expect(page).toMatch(/^<details/);
    expect(page).not.toMatch(/^<details[^>]* open/);
    for (const text of ["GET", "/v2/payments/captures/:id", "200", "120 ms", "dbg123", "https://developer.paypal.com/docs/api/payments/v2/"]) expect(page).toContain(text);
  });

  it("says so where PayPal's debug id isn't available, rather than leaving a blank", () => {
    expect(html([call({ debugId: null, method: "POST", template: "/v2/payments/captures/:id/refund" })])).toContain("not returned to the app");
  });
});
