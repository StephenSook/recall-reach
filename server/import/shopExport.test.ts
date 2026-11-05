import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocateDiscount, parseShopExport } from "./shopExport";

const shopify = readFileSync(new URL("../../test/fixtures/import/shopify_orders_TEST_DATA.csv", import.meta.url), "utf8");

describe("parseShopExport: Shopify orders CSV", () => {
  const { format, lines, rejected } = parseShopExport(shopify);
  const line = (order: string, n: number) => lines.find((l) => l.orderNumber === order && l.lineNo === n);

  it("detects the format", () => {
    expect(format).toBe("shopify");
  });

  it("reads each line item, carrying order fields onto the later rows Shopify leaves blank", () => {
    expect(line("#T1001", 2)).toEqual({
      orderNumber: "#T1001",
      lineNo: 2,
      title: "TEST DATA teether",
      sku: "TEST-SKU-2",
      quantity: 1,
      unitPriceCents: 1000,
      discountCents: 250,
      currency: "USD",
      orderedOn: "2026-03-14",
      paymentReference: "pyid-test-1",
      buyerEmail: "test-buyer-one@example.test",
    });
  });

  it("keeps quoted commas in a title", () => {
    expect(line("#T1001", 1)?.title).toBe("TEST DATA stroller, gray");
  });

  it("allocates the order's discount across its lines by value", () => {
    expect(line("#T1001", 1)?.discountCents).toBe(750);
    expect(line("#T1001", 2)?.discountCents).toBe(250);
  });

  it("does not count a line discount twice when the order total already includes it", () => {
    expect(line("#T1002", 1)).toMatchObject({ quantity: 2, unitPriceCents: 1500, discountCents: 300 });
  });

  it("falls back to Payment References, and leaves a missing email and SKU empty", () => {
    expect(line("#T1002", 1)).toMatchObject({ paymentReference: "pyref-test-2", buyerEmail: null, sku: null });
  });

  it("reports rows it cannot read instead of dropping them", () => {
    expect(rejected.map((r) => [r.orderNumber, r.reason.split(":")[0]])).toEqual([
      ["#T1003", "Lineitem price"],
      ["#T1004", "Currency"],
      ["#T1005", "Created at"],
    ]);
    expect(lines.map((l) => l.orderNumber)).toEqual(["#T1001", "#T1001", "#T1002"]);
  });

  it("carries no address, name or other column it was not asked for", () => {
    const text = JSON.stringify({ lines, rejected });
    for (const absent of ["Testfirst", "Testlast", "1 Test Street", "900001", "test-buyer-three"]) {
      expect(text, absent).not.toContain(absent);
    }
  });
});

describe("parseShopExport: generic CSV", () => {
  it("reads the documented columns in any case", () => {
    const csv =
      "Order_Number,Title,SKU,Quantity,Unit_Price,Discount,Currency,Ordered_On,Payment_Reference,Buyer_Email\n" +
      "S-1,TEST DATA play yard,,1,40.00,5.00,usd,2026-02-01,,test-buyer@example.test\n" +
      "S-1,TEST DATA toy,T-9,2,1.50,,USD,2026-02-01,,\n";
    const { format, lines, rejected } = parseShopExport(csv);
    expect(format).toBe("generic");
    expect(rejected).toEqual([]);
    expect(lines[0]).toMatchObject({ orderNumber: "S-1", lineNo: 1, unitPriceCents: 4000, discountCents: 500, currency: "USD", orderedOn: "2026-02-01", buyerEmail: "test-buyer@example.test", sku: null });
    expect(lines[1]).toMatchObject({ lineNo: 2, sku: "T-9", quantity: 2, unitPriceCents: 150, discountCents: 0, buyerEmail: null });
  });

  it("handles a byte order mark", () => {
    const csv = "﻿order_number,title,quantity,unit_price,currency,ordered_on\nS-2,TEST DATA item,1,2.00,USD,2026-02-02\n";
    expect(parseShopExport(csv).lines).toHaveLength(1);
  });

  it("rejects a zero or fractional quantity and a malformed email", () => {
    const csv =
      "order_number,title,quantity,unit_price,currency,ordered_on,buyer_email\n" +
      "S-3,TEST DATA a,0,2.00,USD,2026-02-02,\n" +
      "S-4,TEST DATA b,1.5,2.00,USD,2026-02-02,\n" +
      "S-5,TEST DATA c,1,2.00,USD,2026-02-02,not-an-email\n";
    const { lines, rejected } = parseShopExport(csv);
    expect(lines).toEqual([]);
    expect(rejected.map((r) => r.reason.split(":")[0])).toEqual(["quantity", "quantity", "buyer_email"]);
    expect(JSON.stringify(rejected)).not.toContain("not-an-email");
  });

  it("refuses a file it does not recognize", () => {
    expect(() => parseShopExport("a,b\n1,2\n")).toThrow(/not a recognized order export/);
  });
});

describe("allocateDiscount", () => {
  it("splits by weight and always sums exactly", () => {
    expect(allocateDiscount(1000, [3000, 1000])).toEqual([750, 250]);
    expect(allocateDiscount(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateDiscount(0, [5, 5])).toEqual([0, 0]);
  });

  it("allocates nothing when no line has value", () => {
    expect(allocateDiscount(100, [0, 0])).toEqual([0, 0]);
  });
});
