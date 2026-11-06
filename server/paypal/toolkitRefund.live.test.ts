// Live test against the real PayPal sandbox: the refund path through the real toolkit.
// Makes one small sandbox capture and refunds part of it. Run with:
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... pnpm exec vitest run --config vitest.live.config.ts server/paypal/toolkitRefund.live.test.ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PayPalApiError, payPalClientFromEnv } from "./client";
import { createCardOrder, getCapture } from "./orders";

describe("create_refund (live sandbox)", () => {
  it("refunds through the toolkit, replays one request id as one refund, and reports a refusal with its status", async () => {
    const client = payPalClientFromEnv();
    const order = await createCardOrder(client, {
      orderNumber: `DEMO-LIVE-TK-${Date.now()}`,
      currency: "USD",
      discountCents: 0,
      lines: [{ title: "DEMO SHOP test item (sandbox)", sku: "DEMO-LIVE", quantity: 1, unitPriceCents: 1200 }],
      requestId: randomUUID(),
      card: { number: "4111111111111111", expiry: "2030-12", securityCode: "123" },
    });
    const capture = order.capture!.id;
    const path = `/v2/payments/captures/${capture}/refund`;
    const amount = (value: string) => ({ amount: { currency_code: "USD", value } });

    const requestId = randomUUID();
    const first = await client.request<{ id: string; status: string }>("POST", path, { requestId, body: amount("2.00") });
    expect(first.data.status).toBe("COMPLETED");
    const replay = await client.request<{ id: string }>("POST", path, { requestId, body: amount("2.00") });
    expect(replay.data.id).toBe(first.data.id);
    expect((await getCapture(client, capture)).status).toBe("PARTIALLY_REFUNDED");
    const read = await client.request<{ seller_payable_breakdown: { total_refunded_amount: { value: string } } }>("GET", `/v2/payments/refunds/${first.data.id}`);
    expect(read.data.seller_payable_breakdown.total_refunded_amount.value).toBe("2.00");

    const refused = await client.request("POST", path, { requestId: randomUUID(), body: amount("100.00") }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PayPalApiError);
    expect((refused as PayPalApiError).status).toBe(422);
    expect((refused as PayPalApiError).uncertain).toBe(false);
    expect((refused as PayPalApiError).issue).toBe("REFUND_AMOUNT_EXCEEDED");
  });
});
