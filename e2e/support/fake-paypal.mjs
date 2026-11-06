// Test only. Node loads this into a local server with --import, so the app's calls to PayPal's sandbox
// land here. The app itself has no setting that can change where a money request goes, on purpose.
// Follows PayPal's rules as measured on the sandbox: a repeated request id returns the original refund
// and moves no more money. A test steers it with the file at FAKE_PAYPAL_CONTROL: { lose: n } loses the next
// n refund answers after the refund lands, and { refuse: n } refuses the next n with a 422.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const HOST = "api-m.sandbox.paypal.com";
const realFetch = globalThis.fetch;
// Real PayPal ids never repeat, and the ledger relies on that, so these differ from run to run.
const run = Date.now().toString(36).toUpperCase();
const orders = new Map();
const captures = new Map();
const refunds = new Map();
function takeFromControl(key) {
  let control = {};
  try {
    control = JSON.parse(readFileSync(process.env.FAKE_PAYPAL_CONTROL, "utf8"));
  } catch {
    return false;
  }
  if (!(control[key] > 0)) return false;
  control[key]--;
  writeFileSync(process.env.FAKE_PAYPAL_CONTROL, JSON.stringify(control));
  return true;
}
let posts = 0;
const requestIds = new Set();

const report = () => {
  writeFileSync(process.env.FAKE_PAYPAL_STATE, JSON.stringify({ posts, made: refunds.size, requestIds: requestIds.size }));
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakePayPal(url, init) {
  const method = init?.method ?? "GET";
  const path = url.pathname;
  if (path === "/v1/oauth2/token") return json({ access_token: "fake-token", expires_in: 32400 });

  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const requestId = new Headers(init?.headers).get("PayPal-Request-Id");

  if (path === "/v2/checkout/orders" && method === "POST") {
    const n = orders.size + 1;
    const unit = body.purchase_units[0];
    const capture = {
      id: `FAKE-CAP-${run}-${n}`,
      status: "COMPLETED",
      create_time: new Date().toISOString(),
      amount: { currency_code: unit.amount.currency_code, value: unit.amount.value },
    };
    captures.set(capture.id, capture);
    const order = { id: `FAKE-ORDER-${run}-${n}`, status: "COMPLETED", purchase_units: [{ ...unit, payments: { captures: [capture] } }] };
    orders.set(order.id, order);
    return json({ id: order.id, status: order.status }, 201);
  }
  const order = /^\/v2\/checkout\/orders\/([\w-]+)$/.exec(path);
  if (order) return json(orders.get(order[1]));

  const capture = /^\/v2\/payments\/captures\/([\w-]+)$/.exec(path);
  if (capture) return json(captures.get(capture[1]));

  const refund = /^\/v2\/payments\/captures\/([\w-]+)\/refund$/.exec(path);
  if (refund && method === "POST") {
    posts++;
    requestIds.add(requestId);
    if (takeFromControl("refuse")) {
      report();
      return json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] }, 422);
    }
    let made = refunds.get(requestId);
    if (!made) {
      made = { id: `FAKE-REF-${run}-${refunds.size + 1}`, status: "COMPLETED", amount: body.amount };
      refunds.set(requestId, made);
      captures.get(refund[1]).status = "REFUNDED";
    }
    report();
    if (takeFromControl("lose")) throw new TypeError("fetch failed");
    return json({ id: made.id, status: made.status }, 201);
  }
  const readRefund = /^\/v2\/payments\/refunds\/([\w-]+)$/.exec(path);
  if (readRefund) {
    const made = [...refunds.values()].find((r) => r.id === readRefund[1]);
    return made ? json({ id: made.id, status: made.status, amount: made.amount }) : json({ name: "NOT_FOUND" }, 404);
  }
  throw new Error(`fake PayPal has no ${method} ${path}`);
}

// The refund itself leaves through PayPal Agent Toolkit, which uses its own copy of axios.
const fromProject = createRequire(join(process.cwd(), "package.json"));
const axiosModule = createRequire(fromProject.resolve("@paypal/agent-toolkit/mcp"))("axios");
const axios = axiosModule.default ?? axiosModule;
axios.defaults.adapter = async (config) => {
  const answer = await fakePayPal(new URL(config.url), { method: config.method.toUpperCase(), headers: config.headers.toJSON(), body: config.data });
  const response = { data: await answer.json(), status: answer.status, statusText: "", headers: {}, config };
  if (answer.status >= 400) throw new axios.AxiosError("refused", "ERR_BAD_REQUEST", config, {}, response);
  return response;
};

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  return url.hostname === HOST ? fakePayPal(url, init) : realFetch(input, init);
};
report();
