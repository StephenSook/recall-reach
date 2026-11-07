// The refund goes out through PayPal Agent Toolkit's create_refund. Only this app's own code calls it, and
// only after a person approved the exact amount. No model is ever handed this tool.
//
// It sits below the app's PayPal client as the way out for that one request, so the client's retries, its
// token refresh and its "no clear answer" logic all apply unchanged. Only this one request goes through here.
//
// Measured on the sandbox and pinned by toolkitRefund.test.ts, because each of these could change with an
// upgrade (version 1.11.0, 2026-11-05):
// - run() never throws. It returns a JSON string: the refund, or { ok: false, status, code, message }, and
//   a dropped connection has no status.
// - request_id belongs to the toolkit instance, so each call gets its own. Without one PayPal makes a new
//   refund every time. Without an amount it refunds the whole payment. So neither can be left out here.
// - It has no timeout of its own. The settings below reach the copy of axios inside the package. axios's own
//   timeout stops counting once headers arrive, so a request also gets a signal that bounds the whole answer.
//
// Loaded on first use, because it adds about 95 MB (measured), and with require, so that the toolkit and the
// axios whose timeout is set here are the same copy. An ESM import would load a different one.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  /** What the buyer reads with the refund. Built from CPSC's record by refundNote. */
  noteToPayer?: string;
}

interface ToolkitAxios {
  defaults: { timeout?: number };
  interceptors: { request: { use(onRequest: (config: { signal?: AbortSignal }) => { signal?: AbortSignal }): unknown } };
}

interface Loaded {
  PayPalMCPToolkit: typeof Toolkit;
  axiosDefaults: ToolkitAxios["defaults"];
  entry: string;
  /** The same copy of debug the toolkit logs through. */
  debug: { disable(): unknown };
}

let loaded: Loaded | undefined;

function load(): Loaded {
  if (!loaded) {
    const fromProject = createRequire(join(process.cwd(), "package.json"));
    const entry = fromProject.resolve(ENTRY);
    const { PayPalMCPToolkit } = fromProject(ENTRY) as { PayPalMCPToolkit: typeof Toolkit };
    const required = createRequire(entry)("axios") as ToolkitAxios & { default?: ToolkitAxios };
    const axios = required.default ?? required;
    const axiosDefaults = axios.defaults;
    axiosDefaults.timeout = TIMEOUT_MS;
    axios.interceptors.request.use((config) => {
      config.signal ??= AbortSignal.timeout(axiosDefaults.timeout ?? TIMEOUT_MS);
      return config;
    });
    loaded = { PayPalMCPToolkit, axiosDefaults, entry, debug: createRequire(entry)("debug") as Loaded["debug"] };
  }
  return loaded;
}

/** Loads the package now, so nobody's first refund waits for it. A refund would load it anyway, so this moves the memory earlier and adds none. */
export function warmToolkit(): void {
  load();
}

function refundToolkit(call: CreateRefundCall): Toolkit {
  const { PayPalMCPToolkit, debug } = load();
  // With DEBUG set, its logger prints the capture id, and logs outlive the 48-hour rule. So off, whatever DEBUG says.
  // disable() also deletes DEBUG, and the health check has to go on seeing it, since other libraries read it too.
  const wanted = process.env.DEBUG;
  debug.disable();
  if (wanted !== undefined) process.env.DEBUG = wanted;
  return new PayPalMCPToolkit({
    accessToken: call.accessToken,
    configuration: { actions: { payments: { createRefund: true } }, context: { sandbox: true, request_id: call.requestId } },
  });
}

/** `baseUrl` is for the contract test's stand-in. Nothing in the app sets it, and no setting can. */
export async function createRefundThroughToolkit(call: CreateRefundCall, opts: { baseUrl?: string } = {}): Promise<unknown> {
  const service = refundToolkit(call).getPaypalAPIService();
  if (opts.baseUrl) service.paypalClient.getBaseUrl = () => opts.baseUrl as string;
  const note = call.noteToPayer ? { note_to_payer: call.noteToPayer } : {};
  return JSON.parse(await service.run("create_refund", { capture_id: call.captureId, amount: call.amount, ...note }));
}

export interface ToolkitInUse {
  version: string | null;
  /** Whether this server has loaded it yet. Start-up does, about 15 seconds in. */
  loaded: boolean;
  tools: string[] | null;
  baseUrl: string | null;
  runs: string;
}

const HOW_IT_RUNS = "In this server's own process, only after a person approves the exact amount. No model is handed the tool.";
let toolsInUse: { tools: string[]; baseUrl: string } | undefined;

/**
 * For /api/health, read from the installed package and not from a copy of its details here. It never loads the package to
 * answer, since that costs about 95 MB, so until start-up has loaded it the tools read as null. It can't fail a health check.
 */
export function toolkitInUse(): ToolkitInUse {
  const none = { version: null, loaded: false, tools: null, baseUrl: null, runs: HOW_IT_RUNS };
  try {
    const fromProject = createRequire(join(process.cwd(), "package.json"));
    const entry = fromProject.resolve(ENTRY);
    const { version } = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")) as { version: string };
    if (!fromProject.cache[entry]) return { ...none, version };
    if (!toolsInUse) {
      const toolkit = refundToolkit({ captureId: "none", amount: { currency_code: "USD", value: "0.00" }, requestId: "none", accessToken: "none" });
      toolsInUse = { tools: toolkit.getTools().map((t) => t.method), baseUrl: toolkit.getPaypalAPIService().paypalClient.getBaseUrl() };
    }
    return { ...none, version, loaded: true, ...toolsInUse };
  } catch (err) {
    console.error("health check: toolkit read failed:", err instanceof Error ? err.name : "unknown error");
    return none;
  }
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

const refundBody = z.object({
  amount: z.object({ currency_code: z.string().min(1), value: z.string().min(1) }),
  note_to_payer: z.string().min(1).max(255).optional(),
});

// The toolkit passes on PayPal's description rather than its issue code, and that prose could name a payment
// or a buyer. What a refusal leaves behind goes into the ledger, which outlives the 48-hour rule, so only a
// code this app already knows is kept. Each phrase is PayPal's own, as measured on the sandbox.
const KNOWN_ISSUES = ["REFUND_AMOUNT_EXCEEDED", "CAPTURE_FULLY_REFUNDED", "REFUND_TIME_LIMIT_EXCEEDED", "TRANSACTION_REFUSED", "PERMISSION_DENIED"];
const KNOWN_PHRASES: [RegExp, string][] = [
  [/must be less than or equal to the capture amount/i, "REFUND_AMOUNT_EXCEEDED"],
  // From PayPal's own negative test of the 180-day limit, Nov 7, 2026 (test/fixtures/paypal/refund-time-limit.json).
  [/over the time limit to perform a refund/i, "REFUND_TIME_LIMIT_EXCEEDED"],
];

function knownIssue(message: string): string | undefined {
  return KNOWN_ISSUES.find((code) => message.includes(code)) ?? KNOWN_PHRASES.find(([phrase]) => phrase.test(message))?.[1];
}

/** The client's own timer still decides when an attempt is over, whatever the toolkit is doing. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
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

    const answer = (await untilAborted(createRefund({ captureId: refund[1], amount: body.data.amount, requestId, accessToken, noteToPayer: body.data.note_to_payer }), init?.signal)) as {
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
