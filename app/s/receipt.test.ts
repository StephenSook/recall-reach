import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptForm } from "./ReceiptForm";
import { ReceiptCard } from "../queue/ReceiptCard";
import { receiptQr } from "@/server/safetyReceipt/qr";

describe("safety receipt screens", () => {
  it("asks for the tag words, email and unchecked consent", () => {
    const page = renderToStaticMarkup(createElement(ReceiptForm, { token: "opaque", shopName: "Our shop", demo: false, deletesAfter: "Nov 14, 2026, 3:00 PM ET" }));
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
    const page = renderToStaticMarkup(createElement(ReceiptForm, { token: "opaque", shopName: "Demo", demo: true, deletesAfter: "Nov 9, 2026, 1:00 AM ET" }));
    expect(page).toContain("DEMO SHOP");
    expect(page).toContain("Nov 9, 2026, 1:00 AM ET");
    expect(page).toContain("Use a test email");
    expect(page).not.toContain("3 years");
  });

  it("is promised nowhere public for longer than the purge keeps it", () => {
    for (const file of ["README.md", "app/privacy/page.tsx", "app/s/ReceiptForm.tsx", "app/queue/ReceiptCard.tsx", "app/queue/safety-receipts/page.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\b(3|three) years\b/i);
    }
    expect(readFileSync("app/privacy/page.tsx", "utf8")).toContain("7 days after a real shop joined, within 48 hours for a demo shop");
    expect(readFileSync("README.md", "utf8")).toContain("7 days after a real shop joined, within 48 hours for a demo shop");
  });

  it("renders a local QR and printable signed link without an outside image service", async () => {
    const link = "https://example.test/s/opaque-signed-token";
    const qr = await receiptQr(link);
    expect(qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(qr.split(",")[1], "base64").toString()).toContain("<svg");
    const page = renderToStaticMarkup(createElement(ReceiptCard, { link, qr, demo: true, deletesAfter: "Nov 9, 2026, 1:00 AM ET" }));
    expect(page).toContain("deleted with this shop&#x27;s data after Nov 9, 2026, 1:00 AM ET");
    expect(page).toContain(link);
    expect(page).toContain("Safety receipt");
    expect(page).toContain("DEMO SHOP");
    expect(page).toContain("Print");
    expect(page).not.toMatch(/[\u2013\u2014\u2018\u2019\u201c\u201d]/);
  });
});
