import { describe, expect, it } from "vitest";
import type { Method, PayPalClient, RequestOptions } from "./client";
import { centsToValue, createCardOrder, getCapture, getOrder, orderIdOfCapture, valueToCents } from "./orders";

function fakeClient(reply: (method: Method, path: string, opts: RequestOptions) => unknown) {
  const calls: { method: Method; path: string; opts: RequestOptions }[] = [];
  const client: PayPalClient = {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      calls.push({ method, path, opts });
      return { status: 200, data: reply(method, path, opts) };
    }) as PayPalClient["request"],
  };
  return { client, calls };
}

// Shape from checkout_orders_v2.json; orders.live.test.ts proves it against the real sandbox.
const ORDER = {
  id: "ORDER-1",
  status: "COMPLETED",
  purchase_units: [
    {
      invoice_id: "#T1",
      custom_id: "#T1",
      items: [
        { name: "Stroller", sku: "SKU-1", quantity: "2", unit_amount: { currency_code: "USD", value: "15.00" } },
        { name: "No SKU item", quantity: "1", unit_amount: { currency_code: "USD", value: "5.50" } },
      ],
      payments: {
        captures: [
          { id: "CAP-1", status: "COMPLETED", create_time: "2026-11-05T21:22:38Z", amount: { currency_code: "USD", value: "35.50" } },
        ],
      },
    },
  ],
  payer: { email_address: "payer@example.test", name: { given_name: "Testgiven" } },
};

describe("money values", () => {
  it("converts PayPal decimal strings and cents without floating point", () => {
    expect(valueToCents("35.50")).toBe(3550);
    expect(valueToCents("0.07")).toBe(7);
    expect(valueToCents("12")).toBe(1200);
    expect(centsToValue(3550)).toBe("35.50");
    expect(centsToValue(7)).toBe("0.07");
  });

  it("refuses a value it cannot read exactly", () => {
    expect(() => valueToCents("1.234")).toThrow(/amount/);
    expect(() => valueToCents("abc")).toThrow(/amount/);
    expect(() => centsToValue(1.5)).toThrow(/cents/);
  });
});

describe("getOrder", () => {
  it("reads the shop's order number, items and capture from Orders v2", async () => {
    const { client, calls } = fakeClient(() => ORDER);
    expect(await getOrder(client, "ORDER-1")).toEqual({
      orderId: "ORDER-1",
      status: "COMPLETED",
      invoiceId: "#T1",
      customId: "#T1",
      amountCents: null,
      currency: null,
      items: [
        { name: "Stroller", sku: "SKU-1", quantity: 2, unitCents: 1500 },
        { name: "No SKU item", sku: null, quantity: 1, unitCents: 550 },
      ],
      capture: { id: "CAP-1", status: "COMPLETED", statusReason: null, createTime: "2026-11-05T21:22:38Z", amountCents: 3550, currency: "USD" },
    });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v2/checkout/orders/ORDER-1" });
  });

  it("reads why PayPal holds the order's capture, as getCapture does", async () => {
    const unit = ORDER.purchase_units[0];
    const held = { ...unit.payments.captures[0], status: "PENDING", status_details: { reason: "BUYER_COMPLAINT" } };
    const { client } = fakeClient(() => ({ ...ORDER, purchase_units: [{ ...unit, payments: { captures: [held] } }] }));
    expect((await getOrder(client, "ORDER-1")).capture).toMatchObject({ status: "PENDING", statusReason: "BUYER_COMPLAINT" });
  });

  it("returns no payer details at all", async () => {
    const { client } = fakeClient(() => ORDER);
    const text = JSON.stringify(await getOrder(client, "ORDER-1"));
    expect(text).not.toContain("payer@example.test");
    expect(text).not.toContain("Testgiven");
  });

  it("reads an order with no item details as an empty list", async () => {
    const bare = { ...ORDER, purchase_units: [{ payments: ORDER.purchase_units[0].payments }] };
    const { client } = fakeClient(() => bare);
    expect(await getOrder(client, "ORDER-1")).toMatchObject({ items: [], invoiceId: null, customId: null });
  });

  it("refuses an id that could change the path", async () => {
    const { client, calls } = fakeClient(() => ORDER);
    await expect(getOrder(client, "../oauth2/token")).rejects.toThrow(/id/);
    expect(calls).toEqual([]);
  });
});

describe("createCardOrder", () => {
  it("sends items, SKU, the shop's order number and a card, with a request id, then reads the order back", async () => {
    const { client, calls } = fakeClient((method) => (method === "POST" ? { id: "ORDER-1", status: "COMPLETED" } : ORDER));
    const facts = await createCardOrder(client, {
      orderNumber: "#T1",
      currency: "USD",
      discountCents: 500,
      lines: [
        { title: "Stroller", sku: "SKU-1", quantity: 2, unitPriceCents: 1500 },
        { title: "No SKU item", sku: null, quantity: 1, unitPriceCents: 1050 },
      ],
      requestId: "req-1",
      card: { number: "4111111111111111", expiry: "2030-12", securityCode: "123" },
    });
    const post = calls[0];
    expect(post).toMatchObject({ method: "POST", path: "/v2/checkout/orders", opts: { requestId: "req-1" } });
    const unit = (post.opts.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0];
    expect(unit).toMatchObject({
      invoice_id: "#T1",
      custom_id: "#T1",
      amount: {
        currency_code: "USD",
        value: "35.50",
        breakdown: { item_total: { currency_code: "USD", value: "40.50" }, discount: { currency_code: "USD", value: "5.00" } },
      },
    });
    expect(unit.items).toEqual([
      { name: "Stroller", sku: "SKU-1", quantity: "2", unit_amount: { currency_code: "USD", value: "15.00" } },
      { name: "No SKU item", quantity: "1", unit_amount: { currency_code: "USD", value: "10.50" } },
    ]);
    expect(calls[1]).toMatchObject({ method: "GET", path: "/v2/checkout/orders/ORDER-1" });
    expect(facts.capture?.id).toBe("CAP-1");
  });

  it("can send a payment with no items, as a plain PayPal payment would look", async () => {
    const { client, calls } = fakeClient((method) => (method === "POST" ? { id: "ORDER-1", status: "COMPLETED" } : ORDER));
    await createCardOrder(client, {
      orderNumber: null,
      currency: "USD",
      discountCents: 0,
      lines: [],
      amountCents: 4200,
      requestId: "req-2",
      card: { number: "4111111111111111", expiry: "2030-12", securityCode: "123" },
    });
    const unit = (calls[0].opts.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0];
    expect(unit).toEqual({ amount: { currency_code: "USD", value: "42.00" } });
  });

  it("can mark a payment with a custom id alone, so it carries no order number to link by", async () => {
    const { client, calls } = fakeClient((method) => (method === "POST" ? { id: "ORDER-1", status: "COMPLETED" } : ORDER));
    await createCardOrder(client, {
      orderNumber: null,
      customId: "POOL",
      currency: "USD",
      discountCents: 0,
      lines: [],
      amountCents: 4200,
      requestId: "req-3",
      card: { number: "4111111111111111", expiry: "2030-12", securityCode: "123" },
    });
    const unit = (calls[0].opts.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0];
    expect(unit).toEqual({ custom_id: "POOL", amount: { currency_code: "USD", value: "42.00" } });
  });

  it("keeps a custom id apart from the shop's order number when both are given", async () => {
    const { client, calls } = fakeClient((method) => (method === "POST" ? { id: "ORDER-1", status: "COMPLETED" } : ORDER));
    await createCardOrder(client, {
      orderNumber: "#T9",
      customId: "POOL",
      currency: "USD",
      discountCents: 0,
      lines: [],
      amountCents: 4200,
      requestId: "req-4",
      card: { number: "4111111111111111", expiry: "2030-12", securityCode: "123" },
    });
    const unit = (calls[0].opts.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0];
    expect(unit).toMatchObject({ invoice_id: "#T9", custom_id: "POOL" });
  });

  it("refuses a real-card-shaped order with neither lines nor an amount", async () => {
    const { client } = fakeClient(() => ORDER);
    await expect(
      createCardOrder(client, {
        orderNumber: null,
        currency: "USD",
        discountCents: 0,
        lines: [],
        requestId: "req-3",
        card: { number: "4111111111111111", expiry: "2030-12", securityCode: "123" },
      }),
    ).rejects.toThrow(/amount/);
  });
});

describe("orderIdOfCapture", () => {
  it("reads the order a capture belongs to", async () => {
    const client: PayPalClient = { request: (async () => ({ status: 200, data: { id: "CAP-1", status: "COMPLETED", amount: { value: "1.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "ORD-1" } } } })) as PayPalClient["request"] };
    expect(await orderIdOfCapture(client, "CAP-1")).toBe("ORD-1");
  });

  it("is null when PayPal does not say", async () => {
    const client: PayPalClient = { request: (async () => ({ status: 200, data: { id: "CAP-1", status: "COMPLETED", amount: { value: "1.00", currency_code: "USD" } } })) as PayPalClient["request"] };
    expect(await orderIdOfCapture(client, "CAP-1")).toBeNull();
  });
});

describe("getCapture", () => {
  it("reads the capture's live status and amount", async () => {
    const { client, calls } = fakeClient(() => ({
      id: "CAP-1",
      status: "PARTIALLY_REFUNDED",
      create_time: "2026-11-05T21:22:38Z",
      amount: { currency_code: "USD", value: "35.50" },
    }));
    expect(await getCapture(client, "CAP-1")).toEqual({
      id: "CAP-1",
      status: "PARTIALLY_REFUNDED",
      createTime: "2026-11-05T21:22:38Z",
      amountCents: 3550,
      currency: "USD",
      statusReason: null,
    });
    expect(calls[0].path).toBe("/v2/payments/captures/CAP-1");
  });

  it("reads why PayPal holds a capture, from its status details", async () => {
    const { client } = fakeClient(() => ({
      id: "CAP-2",
      status: "PENDING",
      status_details: { reason: "BUYER_COMPLAINT" },
      create_time: "2026-11-10T00:32:13Z",
      amount: { currency_code: "USD", value: "18.00" },
    }));
    expect(await getCapture(client, "CAP-2")).toMatchObject({ status: "PENDING", statusReason: "BUYER_COMPLAINT" });
  });
});
