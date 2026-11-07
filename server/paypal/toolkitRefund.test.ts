// The contract with @paypal/agent-toolkit: the real package, against a local stand-in for PayPal. This is
// what proves the refund path keeps its behaviour. An upgrade that changes any of it fails here.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPayPalClient, PayPalApiError } from "./client";
import { createRefundThroughToolkit, refundsThroughToolkit, toolkitInUse, toolkitSetup, warmToolkit, type CreateRefundCall } from "./toolkitRefund";

type Mode = number | "ok" | "drop" | "hang" | "trickle";

describe("create_refund through the toolkit", () => {
  let server: http.Server;
  let base: string;
  let mode: Mode = "ok";
  const seen: { requestId: string | undefined; authorization: string | undefined; path: string; body: Record<string, unknown>; closedEarly: boolean }[] = [];
  const made = new Map<string, string>();
  const contacted: string[] = [];
  const printed: string[] = [];

  beforeAll(async () => {
    // Watch every connection and every line printed, from before the package is first loaded.
    const connect = net.Socket.prototype.connect;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
      const options = args[0] as { host?: string } | [{ host?: string }];
      const first = Array.isArray(options) ? options[0] : options;
      if (first && typeof first === "object" && first.host) contacted.push(first.host);
      return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((text: string) => {
      printed.push(String(text));
      return true;
    }) as typeof process.stdout.write);
    server = http.createServer((req, res) => {
      const entry = { requestId: req.headers["paypal-request-id"] as string | undefined, authorization: req.headers.authorization, path: req.url ?? "", body: {}, closedEarly: false };
      seen.push(entry);
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        entry.body = JSON.parse(raw || "{}");
        if (mode === "drop") return void req.socket.destroy();
        if (mode === "hang") return void res.on("close", () => (entry.closedEarly = !res.writableEnded));
        if (mode === "trickle") {
          // Headers at once, then a little of the body forever: a socket timeout never fires on this.
          res.setHeader("content-type", "application/json");
          res.write('{"id":');
          const drip = setInterval(() => res.write(" "), 50);
          res.on("close", () => {
            clearInterval(drip);
            entry.closedEarly = !res.writableEnded;
          });
          return;
        }
        res.setHeader("content-type", "application/json");
        if (typeof mode === "number") {
          res.statusCode = mode;
          return void res.end(JSON.stringify({ name: "REFUSED", message: "Refused.", details: [{ issue: "SOME_ISSUE", description: "PayPal said no about 9AB12345CD6789012." }] }));
        }
        const id = made.get(entry.requestId ?? "") ?? `REF-${made.size + 1}`;
        made.set(entry.requestId ?? "", id);
        res.statusCode = 201;
        res.end(JSON.stringify({ id, status: "COMPLETED", links: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    mode = "ok";
    seen.length = 0;
  });

  const call = (over: Partial<CreateRefundCall> = {}): CreateRefundCall => ({
    captureId: "CAPTURE-1",
    amount: { currency_code: "USD", value: "30.00" },
    requestId: "request-1",
    accessToken: "token-1",
    ...over,
  });
  /** The package's own request code, with only the address changed. */
  const toStub = (c: CreateRefundCall) => createRefundThroughToolkit(c, { baseUrl: base });

  /** The app's own client, with its retries, and the toolkit as the way out for a refund. */
  const client = (fallback: typeof fetch = (async () => {
    throw new Error("nothing else should be called");
  }) as typeof fetch) =>
    createPayPalClient({
      tokens: { get: async () => "token-1", invalidate: () => {} },
      fetchImpl: refundsThroughToolkit(fallback, toStub),
      sleep: async () => {},
    });
  const refund = (c = client(), path = "/v2/payments/captures/CAPTURE-1/refund") =>
    c.request<{ id: string; status: string }>("POST", path, { requestId: "request-1", body: { amount: { currency_code: "USD", value: "30.00" } } });

  it("sends the capture, the exact amount, the request id and the token", async () => {
    const answer = await toStub(call());
    expect(answer).toMatchObject({ id: expect.stringMatching(/^REF-/), status: "COMPLETED" });
    expect(seen[0]).toMatchObject({
      path: "/v2/payments/captures/CAPTURE-1/refund",
      requestId: "request-1",
      authorization: "Bearer token-1",
      body: { capture_id: "CAPTURE-1", amount: { currency_code: "USD", value: "30.00" } },
    });
  });

  it("passes the note on to PayPal, and sends none when there isn't one", async () => {
    await toStub({ ...call(), noteToPayer: "Refund for a recalled product." });
    expect(seen.at(-1)?.body).toMatchObject({ note_to_payer: "Refund for a recalled product." });
    await toStub(call());
    expect(seen.at(-1)?.body).not.toHaveProperty("note_to_payer");
  });

  it("reaches the app's client as a refund", async () => {
    const { data, status } = await refund();
    expect(status).toBe(201);
    expect(data.status).toBe("COMPLETED");
  });

  it("repeats with the same request id, so the stand-in makes one refund, as PayPal does", async () => {
    const before = made.size;
    const first = await refund(client(), "/v2/payments/captures/CAPTURE-1/refund");
    const second = await refund(client(), "/v2/payments/captures/CAPTURE-1/refund");
    expect(second.data.id).toBe(first.data.id);
    expect(made.size - before).toBeLessThanOrEqual(1);
  });

  describe("failures keep the meaning the refund logic relies on", () => {
    const attemptsFor = async (m: Mode) => {
      mode = m;
      const err = await refund().then(() => null, (e: unknown) => e);
      return { err, attempts: seen.length };
    };

    it.each([400, 403, 404, 409, 422])("a %s is one attempt and a clear error with its status", async (status) => {
      const { err, attempts } = await attemptsFor(status);
      expect(attempts).toBe(1);
      expect(err).toBeInstanceOf(PayPalApiError);
      expect((err as PayPalApiError).status).toBe(status);
      expect((err as PayPalApiError).uncertain).toBe(false);
    });

    it.each([429, 500, 503])("a %s is retried with the same id, then stays uncertain", async (status) => {
      const { err, attempts } = await attemptsFor(status);
      expect(attempts).toBe(3);
      expect(seen.map((s) => s.requestId)).toEqual(["request-1", "request-1", "request-1"]);
      expect((err as PayPalApiError).status).toBe(status);
      expect((err as PayPalApiError).uncertain).toBe(true);
    });

    it("a 401 asks for a fresh token once, then is a clear error", async () => {
      let tokens = 0;
      const c = createPayPalClient({
        tokens: { get: async () => `token-${++tokens}`, invalidate: () => {} },
        fetchImpl: refundsThroughToolkit((async () => new Response()) as typeof fetch, toStub),
        sleep: async () => {},
      });
      mode = 401;
      const err = await refund(c).then(() => null, (e: unknown) => e);
      expect(seen.map((s) => s.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
      expect((err as PayPalApiError).status).toBe(401);
    });

    it("a dropped connection is retried and never reads as a refusal", async () => {
      const { err, attempts } = await attemptsFor("drop");
      expect(attempts).toBe(3);
      expect(err).not.toBeInstanceOf(PayPalApiError);
    });

    it("a refusal after a dropped connection is uncertain", async () => {
      mode = "drop";
      const answers: Mode[] = ["drop", 422];
      const original = server.listeners("request")[0] as http.RequestListener;
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        mode = answers.shift() ?? 422;
        original(req, res);
      });
      const err = await refund().then(() => null, (e: unknown) => e);
      server.removeAllListeners("request");
      server.on("request", original);
      expect((err as PayPalApiError).status).toBe(422);
      expect((err as PayPalApiError).uncertain).toBe(true);
    });

    it("keeps none of PayPal's prose: it can name a payment or a buyer, and the ledger outlives the 48-hour rule", async () => {
      const { err } = await attemptsFor(422);
      expect((err as PayPalApiError).issue).toBeUndefined();
      expect((err as PayPalApiError).message).toBe("PayPal 422 on POST /v2/payments/captures/:id/refund");
    });
  });

  describe("what is kept of a refusal", () => {
    const answerWith = (message: string) =>
      refundsThroughToolkit((async () => new Response()) as typeof fetch, async () => ({ ok: false, status: 422, code: "PAYPAL_API_HTTP_ERROR", message }));
    const issueOf = async (message: string) => {
      const res = await answerWith(message)("https://api-m.sandbox.paypal.com/v2/payments/captures/C/refund", {
        method: "POST",
        headers: { Authorization: "Bearer t", "PayPal-Request-Id": "r" },
        body: JSON.stringify({ amount: { currency_code: "USD", value: "1.00" } }),
      });
      return (await res.json()) as { name?: string; details: { issue?: string }[] };
    };

    it("names a refusal PayPal described in its measured words", async () => {
      const real = "The requested action could not be performed, semantically incorrect, or failed business validation.: The refund amount must be less than or equal to the capture amount that has not yet been refunded.";
      expect((await issueOf(real)).details[0].issue).toBe("REFUND_AMOUNT_EXCEEDED");
    });

    it("keeps an issue code PayPal wrote out, if it is one this app knows", async () => {
      expect((await issueOf("UNPROCESSABLE_ENTITY: CAPTURE_FULLY_REFUNDED")).details[0].issue).toBe("CAPTURE_FULLY_REFUNDED");
    });

    it("keeps nothing of a message it does not recognize", async () => {
      const answer = await issueOf("Payment abc-def-123 belongs to buyer@example.com");
      expect(JSON.stringify(answer)).not.toContain("abc-def-123");
      expect(JSON.stringify(answer)).not.toContain("buyer@example.com");
      expect(answer.details[0].issue).toBeUndefined();
      expect(answer.name).toBeUndefined();
    });
  });

  describe("what makes an unsafe call impossible", () => {
    const refused = (init: RequestInit, path = "/v2/payments/captures/CAPTURE-1/refund") =>
      refundsThroughToolkit((async () => new Response()) as typeof fetch, toStub)(`https://api-m.sandbox.paypal.com${path}`, { method: "POST", ...init });

    it("will not send without a request id: PayPal would make a new refund every time", async () => {
      await expect(refused({ headers: { Authorization: "Bearer t" }, body: JSON.stringify({ amount: { currency_code: "USD", value: "1.00" } }) })).rejects.toThrow(/request id/);
      expect(seen).toEqual([]);
    });

    it("will not send without an amount: PayPal would refund the whole payment", async () => {
      await expect(refused({ headers: { Authorization: "Bearer t", "PayPal-Request-Id": "r" }, body: "{}" })).rejects.toThrow(/amount/);
      expect(seen).toEqual([]);
    });

    it("uses only the sandbox, and only the one tool", async () => {
      warmToolkit();
      const installed = JSON.parse(readFileSync(join(dirname(dirname(createRequire(join(process.cwd(), "package.json")).resolve("@paypal/agent-toolkit/mcp"))), "package.json"), "utf8")) as { version: string };
      expect(toolkitInUse()).toMatchObject({ version: installed.version, loaded: true, tools: ["create_refund"], baseUrl: "https://api.sandbox.paypal.com" });
      const { sandboxBase, tools, requestIdHeader } = await toolkitSetup(call());
      expect(sandboxBase).toBe("https://api.sandbox.paypal.com");
      expect(tools).toEqual(["create_refund"]);
      expect(requestIdHeader).toBe("request-1");
    });

    it("leaves every other PayPal call to the app's own client", async () => {
      const others: string[] = [];
      const route = refundsThroughToolkit((async (input: string) => {
        others.push(String(input));
        return Response.json({});
      }) as unknown as typeof fetch, toStub);
      await route("https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE-1", { method: "GET" });
      await route("https://api-m.sandbox.paypal.com/v2/checkout/orders", { method: "POST", body: "{}" });
      expect(others).toHaveLength(2);
      expect(seen).toEqual([]);
    });
  });

  describe("the timeout", () => {
    it("is set on the copy of axios the package really uses", async () => {
      expect((await toolkitSetup(call())).timeoutMs).toBe(60_000);
    });

    it("gives up on an answer that keeps trickling in, and closes the connection", async () => {
      const { setTimeoutForTest } = await toolkitSetup(call());
      setTimeoutForTest(400);
      mode = "trickle";
      const started = Date.now();
      const answer = await toStub(call());
      expect(Date.now() - started).toBeLessThan(5000);
      expect(answer).toMatchObject({ ok: false });
      expect((answer as { status?: number }).status).toBeUndefined();
      await vi.waitFor(() => expect(seen.at(-1)?.closedEarly).toBe(true));
      setTimeoutForTest(60_000);
    });

    it("stops waiting when the client's own timer fires, whatever the toolkit is doing", async () => {
      const never = new Promise<unknown>(() => {});
      const route = refundsThroughToolkit((async () => new Response()) as typeof fetch, () => never);
      const controller = new AbortController();
      const answer = route("https://api-m.sandbox.paypal.com/v2/payments/captures/C/refund", {
        method: "POST",
        headers: { Authorization: "Bearer t", "PayPal-Request-Id": "r" },
        body: JSON.stringify({ amount: { currency_code: "USD", value: "1.00" } }),
        signal: controller.signal,
      });
      controller.abort(new Error("timed out"));
      await expect(answer).rejects.toThrow();
    });

    it("gives up on a silent PayPal and closes the connection", async () => {
      const { setTimeoutForTest } = await toolkitSetup(call());
      setTimeoutForTest(400);
      mode = "hang";
      const started = Date.now();
      const err = await refund(createPayPalClient({
        tokens: { get: async () => "t", invalidate: () => {} },
        fetchImpl: refundsThroughToolkit((async () => new Response()) as typeof fetch, toStub),
        sleep: async () => {},
      })).then(() => null, (e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(err).not.toBeInstanceOf(PayPalApiError);
      await vi.waitFor(() => expect(seen.at(-1)?.closedEarly).toBe(true));
      setTimeoutForTest(60_000);
    });
  });

  describe("what the package does on its own", () => {
    it("contacts nothing but the stand-in, on load or on a call", async () => {
      await toStub(call());
      expect(contacted.length).toBeGreaterThan(0);
      expect([...new Set(contacted)]).toEqual(["127.0.0.1"]);
    });

    it("prints nothing of its own", async () => {
      await toStub(call());
      expect(printed.filter((line) => !line.includes("vitest"))).toEqual([]);
    });

    it("can't print a capture id, even with its debug logger switched on", async () => {
      const { entry } = await toolkitSetup(call());
      (createRequire(entry)("debug") as { enable(namespaces: string): void }).enable("agent-toolkit:*");
      const logged: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((text: string) => {
        logged.push(String(text));
        return true;
      }) as typeof process.stderr.write);
      try {
        await toStub(call({ captureId: "PRIVATECAPTURE" }));
      } finally {
        stderr.mockRestore();
      }
      expect(logged.join("")).not.toContain("PRIVATECAPTURE");
      expect(logged).toEqual([]);
    });

    it("leaves DEBUG in the environment, so the health check goes on seeing it", async () => {
      vi.stubEnv("DEBUG", "something");
      try {
        await toStub(call());
        expect(process.env.DEBUG).toBe("something");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("can load ahead of the first refund, contacting nothing and printing nothing", () => {
      const contactedBefore = contacted.length;
      const printedBefore = printed.length;
      warmToolkit();
      expect(contacted.length).toBe(contactedBefore);
      expect(printed.length).toBe(printedBefore);
    });

    it("loads no stray .env file and prints nothing when it is loaded", async () => {
      const dir = mkdtempSync(join(tmpdir(), "toolkit-env-"));
      writeFileSync(join(dir, ".env"), "STRAY_FROM_ENV_FILE=leaked\n");
      const { entry } = await toolkitSetup(call());
      const script = `require(${JSON.stringify(entry)}); process.stderr.write(process.env.STRAY_FROM_ENV_FILE ?? "not loaded");`;
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
        execFile(process.execPath, ["-e", script], { cwd: dir, env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv }, (err, out, errOut) => (err ? reject(err) : resolve({ stdout: out, stderr: errOut }))),
      );
      rmSync(dir, { recursive: true });
      expect(stdout).toBe("");
      expect(stderr).toBe("not loaded");
    });
  });

  it("is reached from one file only, and nothing else can hand it to a model", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(100); // a scan of nothing would also find nothing
    const allowed = new Set([
      "package.json",
      "pnpm-lock.yaml",
      "server/paypal/toolkitRefund.ts",
      "server/paypal/toolkitRefund.test.ts",
      "server/paypal/toolkitRefund.live.test.ts",
      "e2e/support/fake-paypal.mjs",
    ]);
    const code = files.filter((f) => /\.(ts|tsx|mjs|cjs|js|json|yaml|yml)$/.test(f) && !allowed.has(f));
    const using = code.filter((f) => /agent-toolkit|createRefundThroughToolkit|create_refund/.test(readFileSync(f, "utf8")));
    expect(using).toEqual([]);
  });

  it("is pinned to the exact version these tests were written against", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@paypal/agent-toolkit"]).toBe("1.11.0");
  });
});
