// PayPal's Customer Disputes API, read before a refund: a payment a buyer has disputed could otherwise be paid back twice.
// Contract: github.com/paypal/paypal-rest-api-specifications openapi/customer_disputes_v1.json (read 2026-11-06). A
// dispute's status is OPEN, WAITING_FOR_BUYER_RESPONSE, WAITING_FOR_SELLER_RESPONSE, UNDER_REVIEW, RESOLVED or OTHER.
// Only the status is read. Nothing here is stored or sent anywhere.
import { z } from "zod";
import type { PayPalClient } from "./client";

export type DisputeState = "NONE" | "OPEN" | "UNREADABLE";

/** PayPal's largest page. A full page can't be called clear: an open dispute could be on the next one. */
const PAGE_SIZE = 50;
const answerSchema = z.object({ items: z.array(z.object({ status: z.string().optional() })).optional() });

/** Anything but a clear answer is UNREADABLE, and anything but RESOLVED counts as open, so a doubt never reads as clear. */
export async function disputeOnCapture(client: PayPalClient, captureId: string): Promise<DisputeState> {
  if (!/^[A-Za-z0-9-]+$/.test(captureId)) return "UNREADABLE";
  try {
    const { data } = await client.request("GET", "/v1/customer/disputes", { query: { disputed_transaction_id: captureId, page_size: String(PAGE_SIZE) } });
    const parsed = answerSchema.safeParse(data);
    if (!parsed.success) return "UNREADABLE";
    const items = parsed.data.items ?? [];
    if (items.some((item) => item.status !== "RESOLVED")) return "OPEN";
    return items.length >= PAGE_SIZE ? "UNREADABLE" : "NONE";
  } catch {
    return "UNREADABLE";
  }
}
