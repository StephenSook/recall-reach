// OAuth client-credentials token for the PayPal REST API (sandbox only).
// Contract: POST /v1/oauth2/token with HTTP Basic client credentials returns
// { access_token, expires_in } (measured 2026-11-05: expires_in 32400 seconds).

/** This app only ever talks to the PayPal sandbox. There is deliberately no live base URL. */
export const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

// Refresh this long before PayPal's stated expiry, so an in-flight request never carries a dead token.
const REFRESH_MARGIN_MS = 60_000;

export interface TokenProvider {
  get(): Promise<string>;
  /** Drop the cached token (after PayPal answers 401). */
  invalidate(): void;
}

export function createTokenProvider(opts: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): TokenProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let cached: { value: string; refreshAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const res = await fetchImpl(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    // The error never echoes the request, so the secret cannot leak into a message or log.
    if (!res.ok) throw new Error(`PayPal token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new Error("PayPal token response is missing access_token or expires_in");
    }
    cached = { value: body.access_token, refreshAt: now() + body.expires_in * 1000 - REFRESH_MARGIN_MS };
    return body.access_token;
  }

  return {
    async get() {
      if (cached && now() < cached.refreshAt) return cached.value;
      if (!inFlight) {
        inFlight = fetchToken().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
