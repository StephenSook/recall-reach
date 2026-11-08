import { describe, expect, it } from "vitest";
import { PayPalApiError, type Method, type PayPalClient, type RequestOptions } from "./client";
import { failedMonths, searchTransactions, searchWindows } from "./transactions";

const DAY = 86_400_000;
const at = (s: string) => new Date(s);

const row = (id: string, over: Record<string, unknown> = {}, cart?: unknown, extra: Record<string, unknown> = {}) => ({
  transaction_info: {
    transaction_id: id,
    transaction_status: "S",
    transaction_event_code: "T0005",
    transaction_initiation_date: "2026-11-05T23:45:14+0000",
    transaction_amount: { currency_code: "USD", value: "95.00" },
    ...over,
  },
  ...(cart === undefined ? {} : { cart_info: cart }),
  ...extra,
});

const page = (rows: unknown[], pageNo = 1, totalPages = 1) => ({ transaction_details: rows, page: pageNo, total_pages: totalPages, total_items: rows.length });

/** Answers each search call from a function of the window and page. */
function fakeSearch(answer: (q: { start: string; end: string; page: number }) => unknown) {
  const calls: { path: string; query: Record<string, string | number> }[] = [];
  const client: PayPalClient = {
    request: (async (_method: Method, path: string, opts: RequestOptions = {}) => {
      const query = opts.query ?? {};
      calls.push({ path, query });
      const a = answer({ start: String(query.start_date), end: String(query.end_date), page: Number(query.page) });
      if (a instanceof Error) throw a;
      return { status: 200, data: a };
    }) as PayPalClient["request"],
  };
  return { client, calls };
}

const FROM = at("2026-10-01T00:00:00Z");
const TO = at("2026-11-05T00:00:00Z");

describe("searchWindows", () => {
  it("covers the whole range in windows of at most 31 days, with no gap and no overlap", () => {
    const from = at("2026-01-01T00:00:00Z");
    const to = at("2026-11-05T12:00:00Z");
    const windows = searchWindows(from, to);
    expect(Date.parse(windows[0].start)).toBe(from.getTime());
    expect(Date.parse(windows.at(-1)!.end)).toBe(to.getTime());
    for (const w of windows) expect(Date.parse(w.end) - Date.parse(w.start)).toBeLessThanOrEqual(31 * DAY);
    for (let i = 1; i < windows.length; i++) expect(Date.parse(windows[i].start)).toBe(Date.parse(windows[i - 1].end) + 1000);
  });

  it("writes times the way PayPal's date pattern requires: seconds and no fraction", () => {
    expect(searchWindows(at("2026-10-01T00:00:00.123Z"), at("2026-10-02T00:00:00.456Z"))[0]).toEqual({
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-02T00:00:00Z",
    });
  });

  it("makes one window for a short range and none for an empty one", () => {
    expect(searchWindows(FROM, at("2026-10-02T00:00:00Z"))).toHaveLength(1);
    expect(searchWindows(TO, FROM)).toEqual([]);
  });
});

describe("searchTransactions", () => {
  it("passes its deadline to every request, so no window starts after it, and the coverage says what didn't run", async () => {
    const seen: (number | undefined)[] = [];
    const deadline = Date.now() + 60_000;
    const client: PayPalClient = {
      request: (async (_m: Method, _path: string, opts: RequestOptions = {}) => {
        seen.push(opts.notAfter);
        if (seen.length > 1) throw new Error("too late to send this request");
        return { status: 200, data: page([]) };
      }) as PayPalClient["request"],
    };
    const { coverage } = await searchTransactions(client, { from: FROM, to: TO }, { notAfter: deadline });
    expect(seen.every((n) => n === deadline)).toBe(true);
    expect(coverage.complete).toBe(false);
    expect(coverage.failedWindows.length).toBe(coverage.windows - 1);
  });

  it("asks for every field at PayPal's largest page size", async () => {
    const { client, calls } = fakeSearch(() => page([]));
    await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(calls[0].path).toBe("/v1/reporting/transactions");
    expect(calls[0].query).toEqual({ start_date: "2026-10-01T00:00:00Z", end_date: "2026-10-05T00:00:00Z", fields: "all", page_size: 500, page: 1 });
  });

  it("returns the facts of a payment with its item names and SKUs", async () => {
    const { client } = fakeSearch(() =>
      page([row("TX1", { invoice_id: "DEMO-1", custom_field: "MARK" }, { item_details: [{ item_name: "Sterilizer", item_code: "SKU-1" }, { item_name: "Bag" }] })]),
    );
    const { payments } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(payments).toEqual([
      {
        transactionId: "TX1",
        invoiceId: "DEMO-1",
        customField: "MARK",
        status: "S",
        paidAt: "2026-11-05T23:45:14.000Z",
        amountCents: 9500,
        currency: "USD",
        items: [
          { name: "Sterilizer", sku: "SKU-1" },
          { name: "Bag", sku: null },
        ],
      },
    ]);
  });

  it("keeps a payment with no item details, and says it has none", async () => {
    const { client } = fakeSearch(() => page([row("TX1")]));
    const { payments } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(payments[0]).toMatchObject({ transactionId: "TX1", invoiceId: null, customField: null, items: [] });
  });

  it("never carries the payer's details out of the response", async () => {
    const { client } = fakeSearch(() => page([row("TX1", {}, undefined, { payer_info: { email_address: "family@example.com", payer_name: { alternate_full_name: "A Family" } } })]));
    const result = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(JSON.stringify(result)).not.toContain("family@example.com");
    expect(JSON.stringify(result)).not.toContain("A Family");
  });

  it("reads every page of a window", async () => {
    const { client, calls } = fakeSearch((q) => (q.page === 1 ? page([row("TX1")], 1, 2) : page([row("TX2")], 2, 2)));
    const { payments, coverage } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(calls.map((c) => c.query.page)).toEqual([1, 2]);
    expect(payments.map((p) => p.transactionId)).toEqual(["TX1", "TX2"]);
    expect(coverage).toMatchObject({ windows: 1, failedWindows: [], rowsRead: 2, complete: true });
  });

  it("removes a transaction listed twice, and counts it", async () => {
    const { client } = fakeSearch(() => page([row("TX1"), row("TX1")]));
    const { payments, coverage } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(payments).toHaveLength(1);
    expect(coverage).toMatchObject({ rowsRead: 2, duplicatesRemoved: 1 });
  });

  it("leaves out refunds and denied payments, and counts them", async () => {
    const { client } = fakeSearch(() =>
      page([row("TX1"), row("REFUND", { transaction_event_code: "T1107", transaction_amount: { currency_code: "USD", value: "-95.00" } }), row("DENIED", { transaction_status: "D" })]),
    );
    const { payments, coverage } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(payments.map((p) => p.transactionId)).toEqual(["TX1"]);
    expect(coverage).toMatchObject({ rowsRead: 3, notPayments: 2 });
  });

  it("leaves out rows that move money but are not sales, such as an account adjustment", async () => {
    const { client } = fakeSearch(() => page([row("TX1"), row("ADJUST", { transaction_event_code: "T1900" }), row("NO-CODE", { transaction_event_code: undefined })]));
    const { payments, coverage } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(payments.map((p) => p.transactionId)).toEqual(["TX1"]);
    expect(coverage.notPayments).toBe(2);
  });

  it("keeps a sale PayPal later reversed: the family still bought it", async () => {
    const { client } = fakeSearch(() => page([row("TX1", { transaction_status: "V" })]));
    expect((await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") })).payments).toHaveLength(1);
  });

  it("records a failed window and still reads the others", async () => {
    const { client } = fakeSearch((q) => (q.start.startsWith("2026-10-01") ? new PayPalApiError(503, "GET", "/v1/reporting/transactions") : page([row("TX2")])));
    const { payments, coverage } = await searchTransactions(client, { from: FROM, to: TO });
    expect(payments.map((p) => p.transactionId)).toEqual(["TX2"]);
    expect(coverage.windows).toBe(2);
    expect(coverage.failedWindows).toHaveLength(1);
    expect(coverage.failedWindows[0].start).toBe("2026-10-01T00:00:00Z");
    expect(coverage.complete).toBe(false);
  });

  it("treats a window as failed when a later page fails, and keeps what it read", async () => {
    const { client } = fakeSearch((q) => (q.page === 1 ? page([row("TX1")], 1, 2) : new TypeError("network down")));
    const { payments, coverage } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(payments.map((p) => p.transactionId)).toEqual(["TX1"]);
    expect(coverage.failedWindows).toHaveLength(1);
    expect(coverage.complete).toBe(false);
  });

  // Measured on the sandbox, 2026-11-06: a window with no rows has no transaction_details at all.
  it("reads a window PayPal says is empty as empty, not as failed", async () => {
    const { client } = fakeSearch(() => ({ account_number: "A", start_date: "s", end_date: "e", last_refreshed_datetime: "t", links: [], page: 1, total_items: 0, total_pages: 0 }));
    const { payments, coverage } = await searchTransactions(client, { from: at("2026-10-01T00:00:00Z"), to: at("2026-10-02T00:00:00Z") });
    expect(payments).toEqual([]);
    expect(coverage).toMatchObject({ failedWindows: [], complete: true, rowsRead: 0 });
  });

  it("does not read a missing list as empty unless PayPal says there are no rows", async () => {
    const { client } = fakeSearch(() => ({ page: 1, total_items: 5, total_pages: 1 }));
    const { coverage } = await searchTransactions(client, { from: at("2026-10-01T00:00:00Z"), to: at("2026-10-02T00:00:00Z") });
    expect(coverage.complete).toBe(false);
    const { client: silent } = fakeSearch(() => ({ page: 1 }));
    expect((await searchTransactions(silent, { from: at("2026-10-01T00:00:00Z"), to: at("2026-10-02T00:00:00Z") })).coverage.complete).toBe(false);
  });

  it("treats an answer it cannot read as a failed window, not as no sales", async () => {
    const { client } = fakeSearch(() => ({ surprise: true }));
    const { coverage } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(coverage.failedWindows).toHaveLength(1);
    expect(coverage.complete).toBe(false);
  });

  it("treats a row it cannot read as a failed window, not as a row to skip", async () => {
    const { client } = fakeSearch(() => page([row("TX1", { transaction_amount: { currency_code: "USD", value: "not money" } })]));
    const { coverage } = await searchTransactions(client, { from: FROM, to: at("2026-10-05T00:00:00Z") });
    expect(coverage.complete).toBe(false);
  });

  it("stops at PayPal's three-year limit and says so", async () => {
    const { client, calls } = fakeSearch(() => page([]));
    const { coverage } = await searchTransactions(client, { from: at("2020-01-01T00:00:00Z"), to: at("2026-11-05T00:00:00Z") });
    expect(coverage.capped).toBe(true);
    expect(Date.parse(String(calls[0].query.start_date))).toBeGreaterThan(Date.parse("2023-11-05T00:00:00Z"));
    expect(coverage.from).toBe(String(calls[0].query.start_date));
  });

  it("does not claim a cap when the range is inside the limit", async () => {
    const { client } = fakeSearch(() => page([]));
    const { coverage } = await searchTransactions(client, { from: FROM, to: TO });
    expect(coverage).toMatchObject({ capped: false, from: "2026-10-01T00:00:00Z", to: "2026-11-05T00:00:00Z", complete: true, rowsRead: 0 });
  });
});

describe("failedMonths", () => {
  it("names every month a failed window touches", () => {
    expect(failedMonths([{ start: "2026-09-20T00:00:00Z", end: "2026-10-20T23:59:59Z" }])).toEqual(["2026-09", "2026-10"]);
    expect(failedMonths([{ start: "2026-09-02T00:00:00Z", end: "2026-09-20T00:00:00Z" }])).toEqual(["2026-09"]);
    expect(failedMonths([])).toEqual([]);
  });
});
