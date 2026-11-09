import { randomUUID } from "node:crypto";
import { getDb } from "@/server/db/pg";
import { createTokenProvider, PAYPAL_SANDBOX_BASE } from "./token";

const LATE = "REFUND_TIME_LIMIT_EXCEEDED";
const MOCK = JSON.stringify({ mock_application_codes: LATE });

export interface JudgeRefusalResult {
  status: number | null;
  expected: boolean;
  details: { issue: string | null; description: string | null }[];
  message: string;
}

const stopped = (message: string): JudgeRefusalResult => ({ status: null, expected: false, details: [], message });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Keep PayPal's words, but never return a raw body, link, debug id or payment id. */
function detailsOf(body: unknown, privateIds: string[]): JudgeRefusalResult["details"] {
  const ids = new Set(privateIds);
  function collect(value: unknown): void {
    if (Array.isArray(value)) value.forEach(collect);
    else for (const [key, item] of Object.entries(record(value))) {
      if (/(^id$|_id$)/i.test(key) && typeof item === "string" && item) ids.add(item);
      else if (item && typeof item === "object") collect(item);
    }
  }
  collect(body);
  const text = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    let clean = value;
    for (const id of ids) clean = clean.replaceAll(id, "[hidden]");
    return clean.replace(/\b(?=[A-Z0-9]{17}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{17}\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[hidden]");
  };
  const data = record(body);
  const details = Array.isArray(data.details) ? data.details : [{ issue: data.name }];
  return details.map((detail) => {
    const value = record(detail);
    return { issue: text(value.issue), description: text(value.description) };
  });
}

const CANDIDATES = 5;

/**
 * Captures of sandbox refunds that completed, newest first, from paypal_refund_refs, which the
 * 46-hour purge empties: no PayPal id is kept longer than that rule allows. Read-only.
 */
async function recentRefundedCaptures(): Promise<string[]> {
  const { rows } = await getDb().query<{ capture_id: string }>(
    `select p.capture_id from paypal_refund_refs p join refunds r on r.id = p.refund_row_id
     where r.status = 'refunded' order by p.received_at desc limit ${CANDIDATES}`,
  );
  return rows.map((row) => row.capture_id);
}

/**
 * Whether there's a refunded sandbox sale on hand to test with. The 46-hour purge empties them, so after a quiet couple of days
 * there's none, and /judge offers something else for thirty seconds. PayPal's own check still runs when the button is pressed.
 */
export async function lateRefundReady(deadlineMs = 1000): Promise<boolean> {
  // The judge page waits on this, so a slow database gives the other row rather than holding the page.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), deadlineMs); });
  try {
    return await Promise.race([recentRefundedCaptures().then((ids) => ids.length > 0), late]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** No app client or call logger: those can retry, replace the mock header, or write records. */
export async function judgeRefusal(opts: {
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  captureIds?: () => Promise<string[]>;
} = {}): Promise<JudgeRefusalResult> {
  const base = opts.baseUrl ?? PAYPAL_SANDBOX_BASE;
  if (base !== "https://api-m.sandbox.paypal.com") return stopped("This test only runs on PayPal's sandbox.");
  const env = opts.env ?? process.env;
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return stopped("This test's PayPal sandbox credentials are not set up.");
  let candidates: string[];
  try {
    candidates = (await (opts.captureIds ?? recentRefundedCaptures)()).filter((id) => /^[A-Za-z0-9-]+$/.test(id)).slice(0, CANDIDATES);
  } catch {
    return stopped("The test couldn't read our refund records just now. No refund request was sent.");
  }
  if (candidates.length === 0) return stopped("There's no recent refunded sandbox sale to test with. Run the refund step above, then try this. No refund request was sent.");
  const fetchImpl = opts.fetchImpl ?? fetch;
  let status: number | null = null;
  try {
    // Token requests must not follow a redirect out of the sandbox either.
    const token = await createTokenProvider({ clientId, clientSecret, fetchImpl: async (input, init) => {
      const response = await fetchImpl(input, { ...init, redirect: "error" });
      status = response.status;
      return response;
    } }).get();
    const headers = { Authorization: `Bearer ${token}` };
    // Use the newest candidate PayPal itself reports as fully refunded right now; never one it doesn't.
    let captureId: string | null = null;
    let last: { status: number; body: unknown; id: string } | null = null;
    for (const id of candidates) {
      status = null;
      const capture = await fetchImpl(`${base}/v2/payments/captures/${id}`, { method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
      status = capture.status;
      const body: unknown = await capture.json();
      if (capture.ok && record(body).status === "REFUNDED") {
        captureId = id;
        break;
      }
      last = { status: capture.status, body, id };
    }
    if (captureId === null) {
      return { status: last?.status ?? status, expected: false, details: last ? detailsOf(last.body, candidates) : [], message: "PayPal did not confirm that this sale was fully refunded. No refund request was sent." };
    }
    const path = `${base}/v2/payments/captures/${captureId}`;
    const requestId = randomUUID();
    status = null;
    const answer = await fetchImpl(`${path}/refund`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "PayPal-Mock-Response": MOCK, "PayPal-Request-Id": requestId },
      body: JSON.stringify({ amount: { value: "0.01", currency_code: "USD" } }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    status = answer.status;
    const details = detailsOf(await answer.json(), [captureId, requestId]);
    const expected = status === 422 && details.length > 0 && details.every((d) => d.issue === LATE && d.description !== null);
    return { status, expected, details, message: expected ? "PayPal refused the late refund." : "Unexpected answer. PayPal did not apply the test header or did not return the late-refund refusal." };
  } catch {
    // Errors can carry URLs and credentials. Keep only an HTTP status we actually received.
    return { ...stopped(status === null ? "PayPal didn't answer. The late-refund test could not be completed." : "PayPal did not return a usable answer. The late-refund test could not be completed."), status };
  }
}
