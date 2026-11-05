// Every call this app makes to the PayPal REST API goes through request(). Sandbox only.
//
// Retry rules: a 401 drops the cached token and retries once. 429, 5xx and network errors are
// retried (up to 3 attempts, with backoff) only for requests that are safe to repeat: GETs, and
// POSTs that carry a PayPal-Request-Id, which PayPal uses to return the original result instead of
// acting twice (measured 2026-11-05 on a refund: same id, same refund). Nothing here logs.
import { createTokenProvider, PAYPAL_SANDBOX_BASE, type TokenProvider } from "./token";

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly issue?: string,
    readonly debugId?: string,
  ) {
    super(`PayPal ${status} on ${method} ${path}${issue ? `: ${issue}` : ""}${debugId ? ` (debug_id ${debugId})` : ""}`);
    this.name = "PayPalApiError";
  }
}

export type Method = "GET" | "POST" | "PATCH";

export interface RequestOptions {
  body?: unknown;
  /** Sent as PayPal-Request-Id; also makes the request safe to retry. */
  requestId?: string;
  query?: Record<string, string | number>;
}

export interface PayPalClient {
  request<T = unknown>(method: Method, path: string, opts?: RequestOptions): Promise<{ status: number; data: T }>;
}

const MAX_ATTEMPTS = 3;

class Retryable extends Error {
  constructor(readonly cause: unknown) {
    super("retryable");
  }
}

async function readError(res: Response, method: string, path: string): Promise<PayPalApiError> {
  let issue: string | undefined;
  let debugId: string | undefined;
  try {
    const body = (await res.json()) as { name?: string; details?: { issue?: string }[]; debug_id?: string };
    issue = body.details?.[0]?.issue ?? body.name;
    debugId = body.debug_id;
  } catch {
    // Not JSON: keep only the status.
  }
  return new PayPalApiError(res.status, method, path, issue, debugId);
}

export function createPayPalClient(opts: {
  tokens: TokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): PayPalClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async request<T>(method: Method, path: string, ro: RequestOptions = {}) {
      if (!/^\/v\d+\/[\w\-/.]+$/.test(path)) throw new Error(`not a PayPal API path: ${path}`);
      const url = new URL(PAYPAL_SANDBOX_BASE + path);
      for (const [k, v] of Object.entries(ro.query ?? {})) url.searchParams.set(k, String(v));
      const retryable = method === "GET" || (method === "POST" && Boolean(ro.requestId));

      let refreshedAfter401 = false;
      for (let attempt = 1; ; attempt++) {
        try {
          const headers: Record<string, string> = { Authorization: `Bearer ${await opts.tokens.get()}` };
          if (ro.body !== undefined) headers["Content-Type"] = "application/json";
          if (ro.requestId) headers["PayPal-Request-Id"] = ro.requestId;

          let res: Response;
          try {
            res = await fetchImpl(url.toString(), {
              method,
              headers,
              body: ro.body === undefined ? undefined : JSON.stringify(ro.body),
              signal: AbortSignal.timeout(60_000),
              cache: "no-store",
            });
          } catch (err) {
            throw new Retryable(err);
          }

          if (res.status === 401 && !refreshedAfter401) {
            refreshedAfter401 = true;
            opts.tokens.invalidate();
            attempt--; // a token refresh is not a failed attempt
            continue;
          }
          if (res.status === 429 || res.status >= 500) throw new Retryable(await readError(res, method, path));
          if (!res.ok) throw await readError(res, method, path);
          const text = await res.text();
          return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
        } catch (err) {
          if (!(err instanceof Retryable)) throw err;
          if (!retryable || attempt >= MAX_ATTEMPTS) {
            throw err.cause instanceof Error ? err.cause : new Error(String(err.cause));
          }
          await sleep(500 * 2 ** (attempt - 1));
        }
      }
    },
  };
}

/** The app's client, from PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app credentials). */
export function payPalClientFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalClient {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)");
  return createPayPalClient({ tokens: createTokenProvider({ clientId, clientSecret }) });
}
