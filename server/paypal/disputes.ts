// PayPal's Customer Disputes API, read before a refund: a payment a buyer has disputed could otherwise be paid back twice.
// Contract: github.com/paypal/paypal-rest-api-specifications openapi/customer_disputes_v1.json (read 2026-11-06).
// Only whether there is one is used. Nothing here is stored or sent anywhere.
import { z } from "zod";
import type { PayPalClient } from "./client";

export type DisputeState = "NONE" | "DISPUTED" | "UNREADABLE";

const PAGE_SIZE = 50;
/** Measured 2026-11-06: a capture with no disputes answers with an empty items list, so a missing list isn't "none". */
const answerSchema = z.object({ items: z.array(z.object({}).passthrough()), links: z.array(z.object({ rel: z.string().optional() })).optional() });

/**
 * Only a clear empty answer is NONE. Any dispute counts, resolved too: PayPal may already have paid the buyer back, and
 * the list doesn't say who won, so the seller checks in PayPal. A doubt never reads as clear.
 */
export async function disputeOnCapture(client: PayPalClient, captureId: string): Promise<DisputeState> {
  if (!/^[A-Za-z0-9-]+$/.test(captureId)) return "UNREADABLE";
  try {
    const { data } = await client.request("GET", "/v1/customer/disputes", { query: { disputed_transaction_id: captureId, page_size: String(PAGE_SIZE) } });
    const parsed = answerSchema.safeParse(data);
    if (!parsed.success) return "UNREADABLE";
    if (parsed.data.items.length > 0) return "DISPUTED";
    return parsed.data.links?.some((link) => link.rel === "next") ? "UNREADABLE" : "NONE";
  } catch {
    return "UNREADABLE";
  }
}
