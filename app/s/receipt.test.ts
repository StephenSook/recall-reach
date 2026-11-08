import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptForm } from "./ReceiptForm";
import { ReceiptCard, shortReceiptLink } from "../queue/ReceiptCard";
import { receiptQr } from "@/server/safetyReceipt/qr";

describe("safety receipt screens", () => {
  it("asks for the tag words, email and unchecked consent", () => {
    const page = renderToStaticMarkup(createElement(ReceiptForm, { token: "opaque", shopName: "Our shop", demo: false, kept: false, deletesAfter: "Nov 14, 2026, 3:00 PM ET" }));
    expect(page).toContain("Item on the tag");
    expect(page).toContain("Brand (optional)");
    expect(page).toContain("Model number (optional)");
    expect(page).toContain("Tell me if this item is recalled.");
    expect(page).not.toContain("checked=");
    // The page promises only what the purge does: the receipt goes with the shop's data, on the date shown.
    expect(page).toContain("after Nov 14, 2026, 3:00 PM ET, when this shop&#x27;s data is deleted");
    expect(page).not.toContain("3 years");
    expect(page).not.toContain("19 months");
    expect(page).toContain('name="website"');
    expect(page).toContain('type="email"');
  });

  it("keeps demo shops labelled and explains their shorter lifetime", () => {
    const page = renderToStaticMarkup(createElement(ReceiptForm, { token: "opaque", shopName: "Demo", demo: true, kept: false, deletesAfter: "Nov 9, 2026, 1:00 AM ET" }));
    expect(page).toContain("DEMO SHOP");
    expect(page).toContain("Nov 9, 2026, 1:00 AM ET");
    expect(page).toContain("Use a test email");
    expect(page).not.toContain("3 years");
  });

  it("promises 3 years for a kept shop only, with the yearly PayPal sign-in that keeps it, and the date it would go", () => {
    const page = renderToStaticMarkup(createElement(ReceiptForm, { token: "opaque", shopName: "Our shop", demo: false, kept: true, deletesAfter: "Nov 8, 2027, 3:00 PM ET" }));
    expect(page).toContain("for up to 3 years");
    expect(page).toContain("signs in with PayPal at least once a year");
    expect(page).toContain("deleted after Nov 8, 2027, 3:00 PM ET");
    expect(page).not.toContain("19 months");
  });

  it("says 3 years nowhere public without the yearly sign-in that keeps a shop, and keeps the 7-day rule beside it", () => {
    for (const file of ["README.md", "app/privacy/page.tsx", "app/s/ReceiptForm.tsx", "app/queue/ReceiptCard.tsx", "app/queue/safety-receipts/page.tsx"]) {
      const text = readFileSync(file, "utf8");
      if (/\b(3|three) years\b/i.test(text)) expect(text, file).toContain("at least once a year");
    }
    expect(readFileSync("app/privacy/page.tsx", "utf8")).toContain("7 days after a real shop joined");
    expect(readFileSync("README.md", "utf8")).toContain("7 days after a real shop joined");
  });

  it("renders a local QR and printable signed link without an outside image service", async () => {
    const link = "https://example.test/s/opaque-signed-token";
    const qr = await receiptQr(link);
    expect(qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(qr.split(",")[1], "base64").toString()).toContain("<svg");
    const page = renderToStaticMarkup(createElement(ReceiptCard, { link, qr, demo: true, kept: false, deletesAfter: "Nov 9, 2026, 1:00 AM ET" }));
    expect(page).toContain("deleted with this shop&#x27;s data after Nov 9, 2026, 1:00 AM ET");
    const kept = renderToStaticMarkup(createElement(ReceiptCard, { link, qr, demo: false, kept: true, deletesAfter: "Nov 8, 2027, 3:00 PM ET" }));
    expect(kept).toContain("up to 3 years");
    expect(kept).toContain("at least once a year");
    expect(kept).toContain("Nov 8, 2027, 3:00 PM ET");
    expect(page).toContain(link);
    expect(page).toContain("Safety receipt");
    expect(page).toContain("DEMO SHOP");
    expect(page).toContain("Print");
    expect(page).not.toMatch(/[\u2013\u2014\u2018\u2019\u201c\u201d]/);
  });
});

describe("the receipt link on the owner's card", () => {
  const link = `https://recall-reach-web-e022.onrender.com/s/${"a".repeat(80)}`;
  const page = () => renderToStaticMarkup(createElement(ReceiptCard, { link, qr: "data:image/svg+xml;base64,AA", demo: false, kept: false, deletesAfter: "Nov 15, 2026" }));

  it("shortens what's shown and keeps the whole address in the link", () => {
    expect(shortReceiptLink(link)).toBe("recall-reach-web-e022.onrender.com/s/...");
    expect(page()).toContain(`href="${link}"`);
    expect(page()).toContain('<span class="receipt-short">recall-reach-web-e022.onrender.com/s/...</span>');
  });

  it("keeps the whole address for print, where the link is what's handed over", () => {
    expect(page()).toContain(`<span class="receipt-full">${link}</span>`);
    expect(page()).toMatch(/\.receipt-full \{ display: none; \}/);
    expect(page()).toMatch(/@media print[\s\S]*\.receipt-short \{ display: none; \}[\s\S]*\.receipt-full \{ display: inline; \}/);
  });
});
