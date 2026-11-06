// The refund goes out through PayPal Agent Toolkit's create_refund. Only this app's own code calls it, and
// only after a person approved the exact amount. No model is ever handed this tool.
//
// It sits below the app's PayPal client as the way out for that one request, so the client's retries, its
// token refresh and its "no clear answer" logic all apply unchanged. Every other PayPal call uses fetch.
//
// Measured on the sandbox and pinned by toolkitRefund.test.ts, because each of these could change with an
// upgrade (version 1.11.0, 2026-11-05):
// - run() never throws. It returns a JSON string: the refund, or { ok: false, status, code, message }, and
//   a dropped connection has no status.
// - request_id belongs to the toolkit instance, so each call gets its own. Without one PayPal makes a new
//   refund every time. Without an amount it refunds the whole payment. So neither can be left out here.
// - It has no timeout of its own. The setting below reaches the copy of axios inside the package.
//
// Loaded on first use, because it adds about 95 MB (measured), and with require, so that the toolkit and the
// axios whose timeout is set here are the same copy. An ESM import would load a different one.
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import type { PayPalMCPToolkit as Toolkit } from "@paypal/agent-toolkit/mcp";

const ENTRY = "@paypal/agent-toolkit/mcp";
const TIMEOUT_MS = 60_000;
const REFUND_PATH = /^\/v2\/payments\/captures\/([A-Za-z0-9-]+)\/refund$/;

export interface CreateRefundCall {
  captureId: string;
  amount: { currency_code: string; value: string };
  requestId: string;
  accessToken: string;
}

interface Loaded {
  PayPalMCPToolkit: typeof Toolkit;
  axiosDefaults: { timeout?: number };
  entry: string;
}

let loaded: Loaded | undefined;

function load(): Loaded {
  if (!loaded) {
    const fromProject = createRequire(join(process.cwd(), "package.json"));
    const entry = fromProject.resolve(ENTRY);
    const { PayPalMCPToolkit } = fromProject(ENTRY) as { PayPalMCPToolkit: typeof Toolkit };
    const axios = createRequire(entry)("axios") as { default?: { defaults: Loaded["axiosDefaults"] }; defaults: Loaded["axiosDefaults"] };
    const axiosDefaults = (axios.default ?? axios).defaults;
    axiosDefaults.timeout = TIMEOUT_MS;
    loaded = { PayPalMCPToolkit, axiosDefaults, entry };
  }
  return loaded;
}

function refundToolkit(call: CreateRefundCall): Toolkit {
  const { PayPalMCPToolkit } = load();
  return new PayPalMCPToolkit({
    accessToken: call.accessToken,
    configuration: { actions: { payments: { createRefund: true } }, context: { sandbox: true, request_id: call.requestId } },
  });
}

/** `baseUrl` is for the contract test's stand-in. Nothing in the app sets it, and no setting can. */
export async function createRefundThroughToolkit(call: CreateRefundCall, opts: { baseUrl?: string } = {}): Promise<unknown> {
  const service = refundToolkit(call).getPaypalAPIService();
  if (opts.baseUrl) service.paypalClient.getBaseUrl = () => opts.baseUrl as string;
  return JSON.parse(await service.run("create_refund", { capture_id: call.captureId, amount: call.amount }));
}

/** What the contract test checks about the real package. */
export async function toolkitSetup(call: CreateRefundCall) {
  const { axiosDefaults, entry } = load();
  const toolkit = refundToolkit(call);
  const client = toolkit.getPaypalAPIService().paypalClient;
  return {
    entry,
    sandboxBase: client.getBaseUrl(),
    tools: toolkit.getTools().map((t) => t.method),
    requestIdHeader: (await client.getHeaders())["PayPal-Request-Id"],
    timeoutMs: axiosDefaults.timeout,
    setTimeoutForTest: (ms: number) => {
      axiosDefaults.timeout = ms;
    },
  };
}

const refundBody = z.object({ amount: z.object({ currency_code: z.string().min(1), value: z.string().min(1) }) });

// The toolkit passes on PayPal's description rather than its issue code, and that prose could name a payment
// or a buyer. What a refusal leaves behind goes into the ledger, which outlives the 48-hour rule, so only a
// code this app already knows is kept. Each phrase is PayPal's own, as measured on the sandbox.
const KNOWN_ISSUES = ["REFUND_AMOUNT_EXCEEDED", "CAPTURE_FULLY_REFUNDED", "REFUND_TIME_LIMIT_EXCEEDED", "TRANSACTION_REFUSED", "PERMISSION_DENIED"];
const KNOWN_PHRASES: [RegExp, string][] = [[/must be less than or equal to the capture amount/i, "REFUND_AMOUNT_EXCEEDED"]];

function knownIssue(message: string): string | undefined {
  return KNOWN_ISSUES.find((code) => message.includes(code)) ?? KNOWN_PHRASES.find(([phrase]) => phrase.test(message))?.[1];
}

/** A fetch for the PayPal client: a refund goes through the toolkit, and anything else goes through `other`. */
export function refundsThroughToolkit(
  other: typeof fetch = (input, init) => fetch(input, init),
  createRefund: (call: CreateRefundCall) => Promise<unknown> = createRefundThroughToolkit,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const refund = REFUND_PATH.exec(url.pathname);
    if (!refund || (init?.method ?? "GET") !== "POST") return other(input, init);

    const headers = new Headers(init?.headers);
    const requestId = headers.get("PayPal-Request-Id");
    if (!requestId) throw new Error("a refund needs a request id");
    const accessToken = /^Bearer (.+)$/.exec(headers.get("Authorization") ?? "")?.[1];
    if (!accessToken) throw new Error("a refund needs a token");
    const body = refundBody.safeParse(JSON.parse(String(init?.body ?? "{}")));
    if (!body.success) throw new Error("a refund needs an amount");

    const answer = (await createRefund({ captureId: refund[1], amount: body.data.amount, requestId, accessToken })) as {
      ok?: boolean;
      id?: unknown;
      status?: unknown;
      code?: unknown;
      message?: unknown;
    } | null;
    if (typeof answer?.id === "string" && typeof answer.status === "string") {
      return Response.json({ id: answer.id, status: answer.status }, { status: 201 });
    }
    if (answer?.ok === false && typeof answer.status === "number") {
      return Response.json({ details: [{ issue: knownIssue(String(answer.message ?? "")) }] }, { status: answer.status });
    }
    // No status means no answer about the refund. The client treats this like a lost connection.
    throw new TypeError("no clear answer from the toolkit");
  };
}
