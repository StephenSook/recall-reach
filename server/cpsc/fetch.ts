// Client for the CPSC Recalls API (public, no key): https://www.saferproducts.gov/RestWebServices/Recall
//
// Contract (measured 2026-11-05):
// - format=json returns a JSON array of recall records with content-type application/json.
// - RecallDateStart/RecallDateEnd and LastPublishDateStart/LastPublishDateEnd filter by day, inclusive.
// - An unknown parameter is silently ignored and returns every recall (10,082 records), so every
//   response is checked against the requested range.
// - LastPublishDate has no time of day; a LastPublishDate range also returns old recalls republished
//   in that window.

export const CPSC_RECALLS_URL = "https://www.saferproducts.gov/RestWebServices/Recall";

export type RangeField = "RecallDate" | "LastPublishDate";

export interface RecallRange {
  field: RangeField;
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  /** Inclusive, YYYY-MM-DD. */
  end: string;
}

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ATTEMPTS = 3;

function assertDay(label: string, value: string): void {
  const t = new Date(`${value}T00:00:00Z`);
  if (!DAY.test(value) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real date as YYYY-MM-DD, got "${value}"`);
  }
}

export function recallsUrl(range: RecallRange): string {
  assertDay("start", range.start);
  assertDay("end", range.end);
  if (range.end < range.start) throw new Error(`end ${range.end} is before start ${range.start}`);
  const url = new URL(CPSC_RECALLS_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set(`${range.field}Start`, range.start);
  url.searchParams.set(`${range.field}End`, range.end);
  return url.toString();
}

class RetryableError extends Error {}

async function attemptOnce(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "recall-reach (CPSC recall matcher)" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    throw new RetryableError(`network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`CPSC returned HTTP ${res.status}`);

  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    throw new RetryableError(`connection dropped mid-answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }
  if (!Array.isArray(payload)) {
    // Firewalls often serve a block or challenge page with HTTP 200; never treat it as data.
    const preview = body.slice(0, 80).replace(/\s+/g, " ");
    throw new Error(`CPSC response is not a JSON array (possibly a firewall challenge page): "${preview}"`);
  }
  // CPSC reports its own database failing as HTTP 200 and one fake row, with the error in Title (measured 2026-11-07).
  // Reading that as data would mark the dates as read and could skip a recall published meanwhile.
  const errorRow = payload.find((r) => {
    const row = r as { RecallID?: unknown; RecallNumber?: unknown } | null;
    return row?.RecallID === 0 && row?.RecallNumber === null;
  }) as { Title?: unknown } | undefined;
  if (errorRow) throw new RetryableError(`CPSC reported an error: "${String(errorRow.Title).slice(0, 80)}"`);
  return payload;
}

function assertInRange(records: unknown[], range: RecallRange): void {
  const outside = records.filter((r) => {
    const value = (r as Record<string, unknown> | null)?.[range.field];
    if (typeof value !== "string") return false; // schema validation reports missing fields
    const day = value.slice(0, 10);
    return day < range.start || day > range.end;
  });
  if (outside.length > 0) {
    throw new Error(
      `CPSC returned ${outside.length} of ${records.length} records outside the requested range ` +
        `${range.field} ${range.start}..${range.end}; the date filter was likely ignored`,
    );
  }
}

/** Fetches raw recall records for a date range. Retries 429, 5xx and network errors with backoff. */
export async function fetchRecalls(range: RecallRange, deps: FetchDeps = {}): Promise<unknown[]> {
  const url = recallsUrl(range);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? 60_000;

  for (let attempt = 1; ; attempt++) {
    try {
      const records = (await attemptOnce(url, fetchImpl, timeoutMs)) as unknown[];
      assertInRange(records, range);
      return records;
    } catch (err) {
      if (!(err instanceof RetryableError)) throw err;
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`CPSC request failed: ${err.message} after ${attempt} attempts`);
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
