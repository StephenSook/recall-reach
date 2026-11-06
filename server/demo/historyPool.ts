// The demo's standing PayPal history: real sandbox captures made once, read back through Transaction
// Search on every run. PayPal takes up to 3 hours to list a capture (about 213 minutes measured once),
// so a shop made a moment ago cannot find its own new sales there, and this pool is what it finds.
//
// A search cannot pick these out by custom id: custom_field came back on no row, even for a capture that
// set custom_id (measured 2026-11-06). So they are picked out by invoice id, or by SKU when they have none.
//
// They are read-only: nothing refunds them. They are dated when they were made, so an order date on a
// line that links to one is demo data and is labelled as seeded. Sessions share one sandbox account,
// which is why the marker matters: it picks these rows out from every other session's payments.
export const HISTORY_POOL_MARKER = "DEMO-HIST";

/** When these captures were made, written here by hand. A line's date must never be read from PayPal's answer, or PayPal's data would outlast its purge. */
export const HISTORY_POOL_MADE_ON = "2026-11-05";

export interface HistoryPoolPayment {
  /** A fixed PayPal-Request-Id, so running the script twice soon after does not make a second payment. */
  requestId: string;
  /** Null makes a payment with no order number to link by. */
  orderNumber: string | null;
  /** Empty makes a payment that says only an amount. */
  lines: { title: string; sku: string; quantity: number; unitPriceCents: number }[];
  amountCents?: number;
}

export const HISTORY_POOL: HistoryPoolPayment[] = [
  {
    requestId: "8f6a4c10-5e0b-4d57-9a01-000000000001",
    orderNumber: "DEMO-HIST-BREZZA",
    lines: [{ title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", sku: "DEMO-BREZZA", quantity: 1, unitPriceCents: 9500 }],
  },
  {
    requestId: "8f6a4c10-5e0b-4d57-9a01-000000000002",
    orderNumber: "DEMO-HIST-BREZZA-FORMULA",
    lines: [{ title: "Baby Brezza Formula Pro Advanced", sku: "DEMO-BREZZA-FORMULA", quantity: 1, unitPriceCents: 12000 }],
  },
  {
    requestId: "8f6a4c10-5e0b-4d57-9a01-000000000003",
    orderNumber: "DEMO-HIST-COSTWAY",
    lines: [{ title: "Costway high chair", sku: "DEMO-COSTWAY", quantity: 1, unitPriceCents: 4000 }],
  },
  {
    requestId: "8f6a4c10-5e0b-4d57-9a01-000000000004",
    orderNumber: "DEMO-HIST-MAMAROO",
    lines: [{ title: "4moms MamaRoo Multi-Motion Swing", sku: "DEMO-MAMAROO", quantity: 1, unitPriceCents: 8500 }],
  },
  {
    requestId: "8f6a4c10-5e0b-4d57-9a01-000000000005",
    orderNumber: "DEMO-HIST-LITTLELOVES",
    lines: [{ title: "Little Loves & Co. boys short set", sku: "DEMO-LITTLELOVES", quantity: 1, unitPriceCents: 1800 }],
  },
  // No order number: two of the shop's lines could claim it by SKU, so it stays ambiguous.
  {
    requestId: "8f6a4c10-5e0b-4d57-9a01-000000000006",
    orderNumber: null,
    lines: [{ title: "G Taleco Gear Baby Jumper", sku: "DEMO-TALECO", quantity: 1, unitPriceCents: 3500 }],
  },
  // Only an amount: no line has this number and it lists no items, so it is counted as unidentified and
  // never cleared. The invoice id is only how a search finds it again.
  { requestId: "8f6a4c10-5e0b-4d57-9a01-000000000008", orderNumber: "DEMO-HIST-NO-ITEMS", lines: [], amountCents: 4200 },
];

const POOL_SKUS = new Set(HISTORY_POOL.flatMap((p) => p.lines.map((l) => l.sku)));

/** Picks the pool's rows out of everything in the account: another session's sale is not this shop's. */
export function poolPayments<T extends { invoiceId: string | null; items: { sku: string | null }[] }>(payments: T[]): T[] {
  return payments.filter((p) => p.invoiceId?.startsWith(`${HISTORY_POOL_MARKER}-`) || (!p.invoiceId && p.items.some((i) => i.sku !== null && POOL_SKUS.has(i.sku))));
}
