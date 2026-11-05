// Live test against the real PayPal sandbox: proves orders.ts parses what PayPal actually returns.
// Creates one small sandbox capture. Run with: PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... pnpm test:live
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { payPalClientFromEnv } from "./client";
import { createCardOrder, getCapture, getOrder } from "./orders";

describe("Orders v2 (live sandbox)", () => {
  it("creates a capture with items and the shop's order number, and reads it back", async () => {
    const client = payPalClientFromEnv();
    const orderNumber = `DEMO-LIVE-${Date.now()}`;
    const created = await createCardOrder(client, {
      orderNumber,
      currency: "USD",
      discountCents: 100,
      lines: [{ title: "DEMO SHOP test item (sandbox)", sku: "DEMO-LIVE", quantity: 2, unitPriceCents: 300 }],
      requestId: randomUUID(),
      card: { number: "4111111111111111", expiry: "2030-12", securityCode: "123" },
    });
    expect(created.status).toBe("COMPLETED");
    expect(created.invoiceId).toBe(orderNumber);
    expect(created.customId).toBe(orderNumber);
    expect(created.items).toEqual([{ name: "DEMO SHOP test item (sandbox)", sku: "DEMO-LIVE", quantity: 2, unitCents: 300 }]);
    expect(created.capture).toMatchObject({ status: "COMPLETED", amountCents: 500, currency: "USD" });

    const again = await getOrder(client, created.orderId);
    expect(again).toEqual(created);
    const capture = await getCapture(client, created.capture!.id);
    expect(capture).toMatchObject({ status: "COMPLETED", amountCents: 500, currency: "USD" });
  });
});
