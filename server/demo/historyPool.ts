// The demo's standing PayPal history: real sandbox captures made once, read back through Transaction
// Search on every run. PayPal takes up to 3 hours to list a capture (about 213 minutes measured once),
// so a shop made a moment ago cannot find its own new sales there, and this pool is what it finds.
//
// They are read-only: nothing refunds them. They are dated when they were made, so an order date on a
// line that links to one is demo data and is labelled as seeded. Sessions share one sandbox account,
// which is why the marker matters: it picks these rows out from every other session's payments.
export const HISTORY_POOL_MARKER = "DEMO-HIST";

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
  // Only an amount: nothing ties it to any line, so it is counted as unidentified and never cleared.
  { requestId: "8f6a4c10-5e0b-4d57-9a01-000000000007", orderNumber: null, lines: [], amountCents: 4200 },
];
