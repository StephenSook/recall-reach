// Every claim on the evidence pages names the file that does it and the words a reader will find there. A test reads
// each file and fails if the words are gone, so these pages can't drift away from the code.
export interface Claim {
  what: string;
  file: string;
  find: string;
}

export const PAYPAL_CLAIMS: Claim[] = [
  { what: "Reads the shop's sales from Transaction Search, across windows, and reports any window that failed", file: "server/paypal/transactions.ts", find: "/v1/reporting/transactions" },
  { what: "Reads the capture from PayPal again before any refund, and again to reconcile", file: "server/paypal/refunds.ts", find: "/v2/payments/captures/" },
  { what: "Sends each refund through PayPal Agent Toolkit, server side", file: "server/paypal/toolkitRefund.ts", find: "refundsThroughToolkit" },
  { what: "Sends one request id per refund, so a retry gets the same refund back", file: "server/paypal/client.ts", find: "PayPal-Request-Id" },
  { what: "Reads the refund back from PayPal to reconcile it", file: "server/paypal/refunds.ts", find: "/v2/payments/refunds/" },
  { what: "Verifies each webhook's signature and certificate before believing it", file: "server/paypal/webhooks.ts", find: "isTrustedCertUrl" },
  { what: "Puts a sale in the queue when a verified capture webhook arrives", file: "server/demo/liveCatch.ts", find: "catchLiveSale" },
  { what: "Is built to follow the 48-hour deletion rule, and purges hourly at 46 hours", file: "server/privacy/retention.ts", find: "PAYPAL_PURGE_CUTOFF_HOURS = 46" },
  { what: "Stores a reference to a PayPal id only as a keyed hash (HMAC), never the id or a plain hash of it", file: "server/privacy/recordKey.ts", find: "createRecordKey" },
  { what: "Sandbox only: webhook certificates are accepted from PayPal's sandbox hosts, and the API base is the sandbox", file: "server/paypal/client.ts", find: "PAYPAL_SANDBOX_BASE" },
];

export const AG_GRID_CLAIMS: Claim[] = [
  { what: "The seller's queue is a grid: every candidate, findable", file: "app/queue/MatchGrid.tsx", find: "AgGridReact" },
  { what: "Recall Replay is a grid: every recall in the run", file: "app/replay/ReplayGrid.tsx", find: "AgGridReact" },
  { what: "Custom cell renderers draw the state and path chips, and the link that opens a sale", file: "app/queue/MatchGrid.tsx", find: "cellRenderer: StateCell" },
  { what: "Multi-row selection, limited to what can really be approved", file: "app/queue/MatchGrid.tsx", find: "isRowSelectable" },
  { what: "Tabs are an external filter over one set of rows", file: "app/queue/MatchGrid.tsx", find: "isExternalFilterPresent" },
  { what: "Quick filter across every column", file: "app/queue/MatchGrid.tsx", find: "quickFilterText" },
  { what: "Column filters, including a date filter on the sale date", file: "app/queue/MatchGrid.tsx", find: "agDateColumnFilter" },
  { what: "CSV export of the Tell CPSC list, limited to columns with no buyer data", file: "app/queue/MatchGrid.tsx", find: "exportDataAsCsv" },
  { what: "A pinned row says how many rows are shown", file: "app/queue/MatchGrid.tsx", find: "pinnedBottomRowData" },
  { what: "Pagination on Recall Replay", file: "app/replay/ReplayGrid.tsx", find: "paginationPageSize" },
  { what: "Community edition only, with a theme set from the app's own colors", file: "app/gridSetup.ts", find: "themeQuartz" },
];
