// Reads a refund back through PayPal's generated Server SDK. Read only: the send stays on the toolkit. It sits below the
// app's PayPal client as a fetch, so retries, errors and tokens above it stay exactly as they are for every other call.
import { ApiError, Client, Environment, PaymentsController } from "@paypal/paypal-server-sdk";

const REFUND_READ = /^\/v2\/payments\/refunds\/([^/]+)$/;
/** The SDK's generated default is 0, which reaches axios as no limit at all. */
const TIMEOUT_MS = 30_000;
/** Only needs to outlast this one call: the token is ours, and the SDK must never try to refresh it. */
const TOKEN_LIFE_S = 3600;

function sdkClient(accessToken: string, timeoutMs: number): Client {
  return new Client({
    environment: Environment.Sandbox,
    timeout: timeoutMs,
    // The token the app already holds, so the SDK never makes a token request: neither a signal nor a timeout would reach one.
    clientCredentialsAuthCredentials: {
      oAuthClientId: "held-by-the-app",
      oAuthClientSecret: "held-by-the-app",
      oAuthToken: { accessToken, tokenType: "Bearer", expiry: BigInt(Math.floor(Date.now() / 1000) + TOKEN_LIFE_S) },
    },
    // Off here, because the app's client already retries a GET, and retry layers multiply.
    httpClientOptions: { timeout: timeoutMs, retryConfig: { maxNumberOfRetries: 0, maximumRetryWaitTime: 0 } },
    // Through the same fetch as every other PayPal call.
    unstable_httpClientOptions: { adapter: "fetch" },
  });
}

/** A fetch for the PayPal client: a refund read goes through the SDK, and anything else goes through `other`. */
export function refundReadsThroughServerSdk(
  other: typeof fetch = (input, init) => fetch(input, init),
  opts: { timeoutMs?: number } = {},
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const read = REFUND_READ.exec(url.pathname);
    if (!read || (init?.method ?? "GET") !== "GET") return other(input, init);

    const accessToken = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("Authorization") ?? "")?.[1];
    if (!accessToken) throw new Error("a refund read needs a token");

    const payments = new PaymentsController(sdkClient(accessToken, opts.timeoutMs ?? TIMEOUT_MS));
    try {
      const answer = await payments.getRefund({ refundId: decodeURIComponent(read[1]) }, { abortSignal: init?.signal ?? undefined });
      const debugId = answer.headers?.["paypal-debug-id"];
      return new Response(String(answer.body), { status: answer.statusCode, headers: { "content-type": "application/json", ...(debugId ? { "paypal-debug-id": debugId } : {}) } });
    } catch (err) {
      // An answer from PayPal, good or bad, is handled above like any other.
      if (err instanceof ApiError) return new Response(typeof err.body === "string" ? err.body : "", { status: err.statusCode, headers: { "content-type": "application/json" } });
      // A failed call is retried above. A new error, with no cause: axios's own carries the request, with its token and id.
      throw new Error("the refund read got no answer from PayPal");
    }
  };
}
