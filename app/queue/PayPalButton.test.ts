import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BuyButtons } from "./BuyButtons";
import { PayPalButton } from "./PayPalButton";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("the shelf buy buttons", () => {
  it("renders nothing extra until PayPal loads and confirms eligibility", () => {
    for (const clientId of ["", "public-client-id"]) {
      expect(renderToStaticMarkup(createElement(PayPalButton, { clientId, shopItemId: "item", stopped: false, onBusy: vi.fn() }))).toBe("");
    }
  });

  it("keeps both original form actions, labels and item fields", () => {
    const html = renderToStaticMarkup(createElement(BuyButtons, { shopItemId: "item", waiting: false, paypalClientId: "public-client-id" }));
    expect(html).toContain('action="/api/demo/buy" method="post"');
    expect(html).toContain('action="/api/demo/buy/paypal" method="post"');
    expect(html.match(/name="shopItemId" value="item"/g)).toHaveLength(2);
    expect(html).toContain("Buy this as a family");
    expect(html).toContain("Buy with a PayPal sandbox login");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("public-client-id");
  });

  it("keeps both original buttons stopped while a sale is on its way", () => {
    const html = renderToStaticMarkup(createElement(BuyButtons, { shopItemId: "item", waiting: true }));
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('data-testid="sale-on-its-way"');
  });
});
