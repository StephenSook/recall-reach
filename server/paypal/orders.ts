// PayPal Orders v2 and Payments v2 capture reads (sandbox), through our tested client.
// Contract: github.com/paypal/paypal-rest-api-specifications openapi/checkout_orders_v2.json and
// payments_payment_v2.json (read 2026-11-05). A capture's status is COMPLETED, PARTIALLY_REFUNDED,
// REFUNDED, PENDING, DECLINED or FAILED; the refunded total is only on refund resources.
//
// Everything returned here is PayPal data: it stays on this server, is kept at most 48 hours
// (server/privacy/retention.ts), and never goes to a third party. Payer details are not read at all.
import { z } from "zod";
import type { PayPalClient } from "./client";

const money = z.object({ currency_code: z.string(), value: z.string() });

const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  purchase_units: z
    .array(
      z.object({
        invoice_id: z.string().optional(),
        custom_id: z.string().optional(),
        items: z
          .array(z.object({ name: z.string(), sku: z.string().optional(), quantity: z.string(), unit_amount: money }))
          .optional(),
        payments: z
          .object({
            captures: z
              .array(z.object({ id: z.string(), status: z.string(), create_time: z.string().optional(), amount: money }))
              .optional(),
          })
          .optional(),
      }),
    )
    .min(1),
});

const captureSchema = z.object({ id: z.string(), status: z.string(), create_time: z.string().optional(), amount: money });

export interface CaptureFacts {
  id: string;
  status: string;
  createTime: string | null;
  amountCents: number;
  currency: string;
}

export interface OrderFacts {
  orderId: string;
  status: string;
  /** The shop's own order number, as the shop set it at checkout. */
  invoiceId: string | null;
  customId: string | null;
  items: { name: string; sku: string | null; quantity: number; unitCents: number }[];
  capture: CaptureFacts | null;
}

/** "35.50" to 3550, exactly. Refuses anything that is not a plain two-decimal amount. */
export function valueToCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new Error("PayPal returned an amount this app cannot read exactly");
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("cents must be a whole non-negative number");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** PayPal ids are letters, digits and hyphens. Anything else could change the request path. */
function pathId(id: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("not a PayPal id");
  return id;
}

function toCapture(c: z.infer<typeof captureSchema>): CaptureFacts {
  return {
    id: c.id,
    status: c.status,
    createTime: c.create_time ?? null,
    amountCents: valueToCents(c.amount.value),
    currency: c.amount.currency_code,
  };
}

export async function getOrder(client: PayPalClient, orderId: string): Promise<OrderFacts> {
  const { data } = await client.request("GET", `/v2/checkout/orders/${pathId(orderId)}`);
  const order = orderSchema.parse(data);
  const unit = order.purchase_units[0];
  const capture = unit.payments?.captures?.[0];
  return {
    orderId: order.id,
    status: order.status,
    invoiceId: unit.invoice_id ?? null,
    customId: unit.custom_id ?? null,
    items: (unit.items ?? []).map((i) => ({
      name: i.name,
      sku: i.sku ?? null,
      quantity: Number(i.quantity),
      unitCents: valueToCents(i.unit_amount.value),
    })),
    capture: capture ? toCapture(capture) : null,
  };
}

export async function getCapture(client: PayPalClient, captureId: string): Promise<CaptureFacts> {
  const { data } = await client.request("GET", `/v2/payments/captures/${pathId(captureId)}`);
  return toCapture(captureSchema.parse(data));
}

export interface CardOrderInput {
  /** The shop's order number; null sends a bare payment with nothing to link it to. */
  orderNumber: string | null;
  /** Sent as custom_id instead of the order number. Lets a payment be recognized without an order number to link by. */
  customId?: string;
  currency: string;
  discountCents: number;
  lines: { title: string; sku: string | null; quantity: number; unitPriceCents: number }[];
  /** Only for a payment with no lines. */
  amountCents?: number;
  /** PayPal-Request-Id, which makes the call safe to retry. */
  requestId: string;
  card: { number: string; expiry: string; securityCode: string };
}

/**
 * Creates and captures a sandbox order server side with a test card (measured 2026-11-05: COMPLETED
 * at once, because Advanced Card Payments is on for the app). Then reads it back.
 */
export async function createCardOrder(client: PayPalClient, input: CardOrderInput): Promise<OrderFacts> {
  const { currency } = input;
  const amount = (cents: number) => ({ currency_code: currency, value: centsToValue(cents) });
  const itemTotal = input.lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);

  let unit: Record<string, unknown>;
  if (input.lines.length === 0) {
    if (!input.amountCents) throw new Error("a payment with no lines needs an amount");
    unit = { amount: amount(input.amountCents) };
  } else {
    unit = {
      amount: {
        ...amount(itemTotal - input.discountCents),
        breakdown: {
          item_total: amount(itemTotal),
          ...(input.discountCents > 0 ? { discount: amount(input.discountCents) } : {}),
        },
      },
      items: input.lines.map((l) => ({
        name: l.title,
        ...(l.sku ? { sku: l.sku } : {}),
        quantity: String(l.quantity),
        unit_amount: amount(l.unitPriceCents),
      })),
    };
  }
  const customId = input.customId ?? input.orderNumber;
  if (customId) unit = { custom_id: customId, ...unit };
  if (input.orderNumber) unit = { invoice_id: input.orderNumber, ...unit };

  const { data } = await client.request<{ id: string }>("POST", "/v2/checkout/orders", {
    requestId: input.requestId,
    body: {
      intent: "CAPTURE",
      purchase_units: [unit],
      payment_source: {
        card: { number: input.card.number, expiry: input.card.expiry, security_code: input.card.securityCode },
      },
    },
  });
  return getOrder(client, data.id);
}
