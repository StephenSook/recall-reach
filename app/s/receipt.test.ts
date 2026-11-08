import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptForm } from "./ReceiptForm";
import { ReceiptCard } from "../queue/ReceiptCard";
import { receiptQr } from "@/server/safetyReceipt/qr";

describe("safety receipt screens", () => {
  it("asks for the tag words, email and unchecked consent", () => {
    const page = renderToStaticMarkup(createElement(ReceiptForm, { token: "opaque", shopName: "Our shop", demo: false }));
    expect(page).toContain("Item on the tag");
    expect(page).toContain("Brand (optional)");
    expect(page).toContain("Model number (optional)");
    expect(page).toContain("Tell me if this item is recalled.");
    expect(page).not.toContain("checked=");
    expect(page).toContain("3 years");
    expect(page).toContain("19 months");
    expect(page).toContain("shop is deleted");
    expect(page).toContain('name="website"');
    expect(page).toContain('type="email"');
  });

  it("keeps demo shops labelled and explains their shorter lifetime", () => {
    const page = renderToStaticMarkup(createElement(ReceiptForm, { token: "opaque", shopName: "Demo", demo: true }));
    expect(page).toContain("DEMO SHOP");
    expect(page).toContain("48 hours");
    expect(page).not.toContain("3 years");
  });

  it("renders a local QR and printable signed link without an outside image service", async () => {
    const link = "https://example.test/s/opaque-signed-token";
    const qr = await receiptQr(link);
    expect(qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(qr.split(",")[1], "base64").toString()).toContain("<svg");
    const page = renderToStaticMarkup(createElement(ReceiptCard, { link, qr, demo: true }));
    expect(page).toContain(link);
    expect(page).toContain("Safety receipt");
    expect(page).toContain("DEMO SHOP");
    expect(page).toContain("Print");
    expect(page).not.toMatch(/[\u2013\u2014\u2018\u2019\u201c\u201d]/);
  });
});
