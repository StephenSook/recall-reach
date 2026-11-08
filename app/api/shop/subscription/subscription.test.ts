import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { loadMigrations, migrate } from "@/server/db/migrate";
import { createShop } from "@/server/import/store";
import { createRecordKey } from "@/server/privacy/recordKey";
import { createContactCipher } from "@/server/privacy/contactCipher";
import { purgePayPalData } from "@/server/privacy/retention";
import { sessionCookie } from "@/server/session/session";
import { SHOP_PLAN, subscriptionCustomId } from "@/server/paypal/subscriptions";
import { cancelShopSubscription, readShopSubscription, startShopSubscription, syncSubscriptionEvent } from "@/server/shop/subscription";
import { handleWebhookDelivery } from "@/server/paypal/webhookHandler";
import { fetchTestCert, paypalHeaders } from "@/test/paypalSigner";
import { trustedMessage } from "@/server/web/queueMessage";
import { createPayPalClient, PayPalApiError, type PayPalClient } from "@/server/paypal/client";

vi.mock("@/server/db/pg", () => ({ getBillingDb: vi.fn() }));
const jar = vi.hoisted(() => ({ value: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => jar.value ? { value: jar.value } : undefined }) }));
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/server/paypal/client", async (original) => ({ ...(await original<typeof import("@/server/paypal/client")>()), payPalClientFromEnv: () => api }));
import { getBillingDb } from "@/server/db/pg";
import { POST as start } from "./start/route";
import { GET as back } from "./return/route";
import { POST as cancel } from "./cancel/route";

const SESSION = "s".repeat(64), RECORD = "r".repeat(64), SECRET = "d".repeat(64), SITE = "http://localhost:3000";
const key = createRecordKey(RECORD);
const subscriptionId = "I-TEST-SUB";
const approve = "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=test";

describe("shop subscription routes, storage and verified webhook routing", () => {
  let db: Awaited<ReturnType<typeof testDb>>, shopId: string;
  let reply: Record<string, unknown>;
  let plan: Record<string, unknown>;
  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", SESSION); vi.stubEnv("RECORD_HMAC_SECRET", RECORD); vi.stubEnv("SHOP_DATA_KEY", SECRET);
    vi.stubEnv("RENDER_EXTERNAL_URL", ""); vi.stubEnv("PAYPAL_SUBSCRIPTION_PLAN_ID", "P-TEST");
    db = await testDb(); await migrate(db); vi.mocked(getBillingDb).mockReturnValue(db);
    shopId = await createShop(db, { name: "A real shop", kind: "REAL" });
    jar.value = sessionCookie(SESSION, shopId).value;
    reply = { id: subscriptionId, status: "APPROVAL_PENDING", plan_id: "P-TEST", custom_id: subscriptionCustomId(key, shopId), links: [{ rel: "approve", href: approve }] };
    plan = { id: "P-TEST", status: "ACTIVE", name: SHOP_PLAN.name, billing_cycles: [{ frequency: { interval_unit: SHOP_PLAN.interval, interval_count: 1 }, tenure_type: "REGULAR", total_cycles: 0, pricing_scheme: { fixed_price: { value: SHOP_PLAN.value, currency_code: SHOP_PLAN.currency } } }] };
    api.request.mockReset().mockImplementation(async (method: string, path: string) => ({ status: 201, data: method === "GET" && path === "/v1/billing/plans/P-TEST" ? plan : reply }));
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.close(); });
  const post = (path: string, origin = SITE, body = "") => new Request(`${SITE}/api/shop/subscription/${path}`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body });
  const comeBack = (id = subscriptionId) => back(new Request(`${SITE}/api/shop/subscription/return?subscription_id=${id}`));
  const stored = async () => (await db.query<Record<string, unknown>>("select * from shop_subscriptions where shop_id = $1", [shopId])).rows[0];
  const message = (res: Response) => { const u = new URL(res.headers.get("location")!); return trustedMessage(SESSION, u.searchParams.get("message") ?? undefined, u.searchParams.get("sig") ?? undefined); };

  it("creates once, saves only a hash and sealed id, and redirects to sandbox approval", async () => {
    const first = await start(post("start"));
    expect(first.status).toBe(303); expect(first.headers.get("location")).toBe(approve);
    const row = await stored();
    expect(row).toMatchObject({ subscription_id_hmac: key("paypal-resource", subscriptionId), plan_id: "P-TEST", status: "APPROVAL_PENDING" });
    const refs = (await db.query<{ subscription_id_sealed: string }>("select * from paypal_subscription_refs")).rows;
    expect(JSON.stringify([row, refs])).not.toContain(subscriptionId);
    expect(createContactCipher(SECRET, shopId).open(refs[0].subscription_id_sealed)).toBe(subscriptionId);
    expect(api.request.mock.calls[0]).toEqual(["GET", "/v1/billing/plans/P-TEST"]);
    const writes = api.request.mock.calls.filter(([method]) => method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0][2].requestId).toBe(row.request_id);
    expect(writes[0][2].notAfter).toBe(new Date(row.create_started_at as Date).getTime() + 6 * 3_600_000);
    api.request.mockClear(); vi.stubEnv("PAYPAL_SUBSCRIPTION_PLAN_ID", "P-OTHER");
    expect((await start(post("start"))).headers.get("location")).toBe(approve);
    expect(api.request.mock.calls).toEqual([["GET", `/v1/billing/subscriptions/${subscriptionId}`]]);
  });

  it("refuses a configured plan with a different price before creating a subscription", async () => {
    plan = { ...plan, billing_cycles: [{ frequency: { interval_unit: SHOP_PLAN.interval, interval_count: 1 }, tenure_type: "REGULAR", total_cycles: 0, pricing_scheme: { fixed_price: { value: "6.00", currency_code: SHOP_PLAN.currency } } }] };
    expect(message(await start(post("start")))).toContain("no clear subscription answer");
    expect(api.request.mock.calls).toEqual([["GET", "/v1/billing/plans/P-TEST"]]);
    expect(await stored()).toMatchObject({ subscription_id_hmac: null });
  });

  it("refuses a stored plan different from the configured plan before creating a subscription", async () => {
    await db.query("insert into shop_subscriptions (shop_id, plan_id, create_started_at) values ($1, 'P-OLD', now())", [shopId]);
    expect(message(await start(post("start")))).toContain("stored plan differs from the configured plan");
    expect(api.request).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ plan_id: "P-OLD", subscription_id_hmac: null });
  });

  it.each(["read error", "inactive plan"])("can first create seven hours after a failed plan check: %s", async (failure) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    if (failure === "read error") api.request.mockRejectedValueOnce(new Error("plan unavailable"));
    else api.request.mockResolvedValueOnce({ status: 200, data: { ...plan, status: "INACTIVE" } });
    expect(message(await start(post("start")))).toContain("no clear subscription answer");
    const reserved = await stored();
    expect(reserved).toMatchObject({ create_started_at: null, subscription_id_hmac: null });
    now += 7 * 3_600_000;
    expect((await start(post("start"))).headers.get("location")).toBe(approve);
    const row = await stored();
    expect(row.request_id).toBe(reserved.request_id);
    expect(new Date(row.create_started_at as Date).getTime()).toBe(now);
    const writes = api.request.mock.calls.filter(([method]) => method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0][2]).toMatchObject({ requestId: reserved.request_id, notAfter: now + 6 * 3_600_000 });
  });

  it("adopts a rotated plan before any create, keeping the reserved request id", async () => {
    await db.query("insert into shop_subscriptions (shop_id, plan_id, requested_at) values ($1, 'P-OLD', now() - interval '7 hours')", [shopId]);
    const requestId = (await stored()).request_id;
    expect((await start(post("start"))).headers.get("location")).toBe(approve);
    expect(await stored()).toMatchObject({ plan_id: "P-TEST", request_id: requestId });
    expect(api.request.mock.calls.find(([method]) => method === "POST")?.[2]).toMatchObject({ requestId, body: expect.objectContaining({ plan_id: "P-TEST" }) });
  });

  it("keeps the committed create marker when the POST transaction rolls back, refusing a retry seven hours later", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    api.request.mockResolvedValueOnce({ status: 200, data: plan }).mockRejectedValueOnce(new Error("lost create reply"));
    expect(message(await start(post("start")))).toContain("no clear subscription answer");
    const row = await stored();
    expect(row).toMatchObject({ subscription_id_hmac: null, status: null });
    expect(new Date(row.create_started_at as Date).getTime()).toBe(now);
    now += 7 * 3_600_000;
    api.request.mockClear();
    expect(message(await start(post("start")))).toContain("needs checking");
    expect(api.request.mock.calls).toEqual([["GET", "/v1/billing/plans/P-TEST"]]);
    expect((await stored()).request_id).toBe(row.request_id);
    expect((await stored()).create_started_at).toEqual(row.create_started_at);
  });

  it.each([1, 2])("refuses a busy per-shop try-lock in transaction %s without a create POST", async (busyTransaction) => {
    const transaction = db.transaction.bind(db);
    let turn = 0;
    vi.spyOn(db, "transaction").mockImplementation((fn) => transaction((tx) => {
      const busy = ++turn === busyTransaction;
      const query = tx.query.bind(tx);
      vi.spyOn(tx, "query").mockImplementation((sql, params) => busy && sql.includes("pg_try_advisory_xact_lock")
        ? Promise.resolve({ rows: [{ locked: false }] }) : query(sql, params));
      return fn(tx);
    }));
    expect(message(await start(post("start")))).toContain("already running");
    expect(api.request.mock.calls.filter(([method]) => method === "POST")).toEqual([]);
    expect((await stored()).create_started_at === null).toBe(busyTransaction === 1);
  });

  it("reuses the reserved request id after an unclear answer, and never retries beyond six hours", async () => {
    api.request.mockResolvedValueOnce({ status: 200, data: plan }).mockRejectedValueOnce(new Error("no answer"));
    await start(post("start")); const requestId = (await stored()).request_id;
    await start(post("start"));
    expect(api.request.mock.calls.filter(([method]) => method === "POST").map(([, , options]) => options.requestId)).toEqual([requestId, requestId]);
    await db.query("delete from paypal_subscription_refs");
    await db.query("update shop_subscriptions set subscription_id_hmac = null, create_started_at = now() - interval '7 hours'");
    api.request.mockClear(); expect(message(await start(post("start")))).toContain("needs checking");
    expect(api.request.mock.calls).toEqual([["GET", "/v1/billing/plans/P-TEST"]]);
  });

  it("does not POST when a slow plan read crosses the request-id cutoff", async () => {
    const beganAt = Date.now();
    let now = beganAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await db.query("insert into shop_subscriptions (shop_id, plan_id, create_started_at) values ($1, 'P-TEST', $2)", [shopId, new Date(beganAt - 6 * 3_600_000 + 1000)]);
    api.request.mockImplementationOnce(async () => {
      now += 2000;
      return { status: 200, data: plan };
    });
    expect(message(await start(post("start")))).toContain("needs checking");
    expect(api.request.mock.calls).toEqual([["GET", "/v1/billing/plans/P-TEST"]]);
    expect(await stored()).toMatchObject({ subscription_id_hmac: null, status: null });
  });

  it.each(["token wait", "retry backoff"])("sends no further create POST when a %s crosses the request-id cutoff", async (wait) => {
    const beganAt = Date.now();
    let now = beganAt, tokenCalls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await db.query("insert into shop_subscriptions (shop_id, plan_id, create_started_at) values ($1, 'P-TEST', $2)", [shopId, new Date(beganAt - 6 * 3_600_000 + 1000)]);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json(plan);
      return wait === "retry backoff" ? Response.json({}, { status: 503 }) : Response.json(reply, { status: 201 });
    });
    const sleep = vi.fn(async () => { now += 2000; });
    const client = createPayPalClient({
      tokens: { get: async () => { if (++tokenCalls === 2 && wait === "token wait") now += 2000; return "token"; }, invalidate: () => {} },
      fetchImpl, sleep,
    });
    await expect(startShopSubscription(db, client, { shopId, recordKey: key, secret: SECRET, planId: "P-TEST", site: SITE })).rejects.toThrow(/too late/);
    const posts = fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(wait === "token wait" ? 0 : 1);
    expect(sleep).toHaveBeenCalledTimes(wait === "token wait" ? 0 : 1);
    expect(await stored()).toMatchObject({ subscription_id_hmac: null, status: null, closed: false });
  });

  it("refuses missing sessions, cross-origin POSTs, DEMO shops and an unset plan before PayPal", async () => {
    jar.value = ""; expect((await start(post("start"))).status).toBe(401);
    jar.value = sessionCookie(SESSION, shopId).value; expect((await start(post("start", "https://other.test"))).status).toBe(403);
    expect((await cancel(post("cancel", "https://other.test"))).status).toBe(403);
    const demo = await createShop(db, { name: "Demo", kind: "DEMO" }); jar.value = sessionCookie(SESSION, demo).value;
    expect(message(await start(post("start")))).toContain("real shops only");
    expect(message(await comeBack())).toContain("real shops only");
    expect(message(await cancel(post("cancel")))).toContain("real shops only");
    jar.value = sessionCookie(SESSION, shopId).value; vi.stubEnv("PAYPAL_SUBSCRIPTION_PLAN_ID", "");
    expect(message(await start(post("start")))).toContain("PLAN_ID is missing");
    expect(api.request).not.toHaveBeenCalled(); expect(await stored()).toBeUndefined();
  });

  it.each(["ACTIVE", "APPROVAL_PENDING", "APPROVED", "SUSPENDED", "CANCELLED", "EXPIRED"])("stores the returned %s honestly and signs the queue message", async (status) => {
    await start(post("start")); reply = { ...reply, status, start_time: "2026-11-08T12:00:00Z" };
    const res = await comeBack(); expect(new URL(res.headers.get("location")!).pathname).toBe("/queue");
    expect(message(res)).toContain(`PayPal reports ${status}`);
    expect(await stored()).toMatchObject({ status });
    expect((await readShopSubscription(db, shopId))?.startedAt).toBe(status === "ACTIVE" ? "2026-11-08T12:00:00.000Z" : null);
  });

  it("refuses a custom_id mismatch, a different plan, and a subscription not started here", async () => {
    await start(post("start")); reply = { ...reply, status: "ACTIVE", custom_id: "another-shop" };
    expect(message(await comeBack())).toContain("does not belong"); expect((await stored()).status).toBe("APPROVAL_PENDING");
    reply = { ...reply, custom_id: subscriptionCustomId(key, shopId), plan_id: "P-OTHER" };
    expect(message(await comeBack())).toContain("does not belong");
    api.request.mockClear(); expect(message(await comeBack("I-OTHER"))).toContain("not started"); expect(api.request).not.toHaveBeenCalled();
    jar.value = ""; expect((await comeBack()).status).toBe(401);
  });

  it("leaves the previous status open when the cancel POST fails", async () => {
    await start(post("start")); reply = { ...reply, status: "ACTIVE" }; await comeBack();
    api.request.mockImplementation(async (method: string) => { if (method === "POST") throw new Error("no answer"); return { status: 200, data: reply }; });
    api.request.mockClear();
    expect(message(await cancel(post("cancel")))).toContain("no clear subscription answer");
    expect(await stored()).toMatchObject({ status: "ACTIVE", closed: false });
    expect(api.request.mock.calls.map(([method]) => method)).toEqual(["GET", "POST"]);
  });

  it.each([
    [new PayPalApiError(422, "POST", `/v1/billing/subscriptions/${subscriptionId}/cancel`, "PRIVATE_ISSUE", "PRIVATE_DEBUG_ID"), "PayPal refused the request (HTTP 422)."],
    [new PayPalApiError(503, "POST", `/v1/billing/subscriptions/${subscriptionId}/cancel`), "PayPal gave no clear subscription answer."],
    [Object.assign(new PayPalApiError(422, "POST", `/v1/billing/subscriptions/${subscriptionId}/cancel`), { uncertain: true }), "PayPal gave no clear subscription answer."],
    [new Error(`network error ${subscriptionId}`), "PayPal gave no clear subscription answer."],
    [new DOMException(`timeout ${subscriptionId}`, "TimeoutError"), "PayPal gave no clear subscription answer."],
  ])("reports a refused or uncertain cancellation without PayPal ids: %s", async (error, expected) => {
    await start(post("start")); reply = { ...reply, status: "ACTIVE" }; await comeBack();
    api.request.mockImplementation(async (method: string) => { if (method === "POST") throw error; return { status: 200, data: reply }; });
    const text = message(await cancel(post("cancel")));
    expect(text).toBe(`${expected}${expected.includes("no clear") ? " Check PayPal before trying again." : ""} PayPal sandbox, no real charge. Everything that keeps families safe stays free.`);
    expect(text).not.toMatch(/I-TEST-SUB|PRIVATE_ISSUE|PRIVATE_DEBUG_ID/);
    expect(await stored()).toMatchObject({ status: "ACTIVE", closed: false });
  });

  it.each([
    ["CANCELLED", "Subscription cancelled."],
    ["EXPIRED", "This subscription has expired."],
    ["ACTIVE", "Cancel sent, but PayPal still reports ACTIVE. Check your PayPal sandbox account."],
    ["APPROVAL_PENDING", "Cancel sent, but PayPal still reports APPROVAL_PENDING. Check your PayPal sandbox account."],
    ["APPROVED", "Cancel sent, but PayPal still reports APPROVED. Check your PayPal sandbox account."],
    ["SUSPENDED", "Cancel sent, but PayPal still reports SUSPENDED. Check your PayPal sandbox account."],
  ])("saves PayPal's post-cancel %s status and closes only terminal rows", async (status, expectedMessage) => {
    await start(post("start")); reply = { ...reply, status: "ACTIVE", start_time: "2026-11-08T12:00:00Z" }; await comeBack();
    api.request.mockReset()
      .mockResolvedValueOnce({ status: 200, data: reply })
      .mockResolvedValueOnce({ status: 204, data: undefined })
      .mockResolvedValueOnce({ status: 200, data: { ...reply, status } });
    expect(message(await cancel(post("cancel")))).toBe(`${expectedMessage} PayPal sandbox, no real charge. Everything that keeps families safe stays free.`);
    const closed = status === "CANCELLED" || status === "EXPIRED";
    expect(await stored()).toMatchObject({ status, closed });
    expect(await readShopSubscription(db, shopId)).toMatchObject({ status, closed, startedAt: status === "ACTIVE" ? "2026-11-08T12:00:00.000Z" : null });
    expect(api.request.mock.calls).toEqual([
      ["GET", `/v1/billing/subscriptions/${subscriptionId}`],
      ["POST", `/v1/billing/subscriptions/${subscriptionId}/cancel`, { requestId: `c-${(await stored()).request_id}`, body: { reason: "The shop owner cancelled Recall Reach for shops." } }],
      ["GET", `/v1/billing/subscriptions/${subscriptionId}`],
    ]);
    if (closed) {
      api.request.mockResolvedValue({ status: 200, data: reply });
      expect(message(await comeBack())).toContain("already closed");
      expect((await stored()).status).toBe(status);
    }
  });

  it.each(["CANCELLED", "EXPIRED", null])("reports an already-closed row with status %s without calling PayPal", async (status) => {
    await start(post("start"));
    await db.query("update shop_subscriptions set status = $1, closed = true where shop_id = $2", [status, shopId]);
    await db.query("delete from paypal_subscription_refs where shop_id = $1", [shopId]);
    api.request.mockClear();
    expect(await cancelShopSubscription(db, api as PayPalClient, { shopId, recordKey: key, secret: SECRET })).toEqual({ status, closed: true, alreadyClosed: true });
    expect(message(await cancel(post("cancel")))).toBe("This subscription was already cancelled or expired. PayPal sandbox, no real charge. Everything that keeps families safe stays free.");
    expect(api.request).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ status, closed: true });
  });

  it("purges ids and status facts, retains the hash, and cancels with an owner-supplied matching id", async () => {
    await start(post("start"));
    await db.query("update shop_subscriptions set updated_at = now() - interval '47 hours', started_at = now() - interval '48 hours'");
    await db.query("update paypal_subscription_refs set received_at = now() - interval '47 hours'");
    const counts = await purgePayPalData(db);
    expect(counts.paypal_subscription_refs).toBe(1); expect(counts.subscription_statuses).toBe(1);
    expect(await stored()).toMatchObject({ subscription_id_hmac: key("paypal-resource", subscriptionId), status: null, started_at: null });
    api.request.mockClear(); expect(message(await start(post("start")))).toContain("raw id is no longer kept"); expect(api.request).not.toHaveBeenCalled();
    expect(message(await cancel(post("cancel", SITE, "subscriptionId=I-OTHER")))).toContain("does not belong");
    reply = { ...reply, status: "ACTIVE" };
    expect(message(await cancel(post("cancel", SITE, `subscriptionId=${subscriptionId}`)))).toBe("Cancel sent, but PayPal still reports ACTIVE. Check your PayPal sandbox account. PayPal sandbox, no real charge. Everything that keeps families safe stays free.");
  });

  it("migration enforces one subscription per shop and cascades both tables on deletion", async () => {
    await start(post("start"));
    await expect(db.query("insert into shop_subscriptions (shop_id, plan_id) values ($1, 'P-OTHER')", [shopId])).rejects.toThrow();
    await db.query("delete from shops where id = $1", [shopId]);
    expect((await db.query("select * from shop_subscriptions")).rows).toEqual([]);
    expect((await db.query("select * from paypal_subscription_refs")).rows).toEqual([]);
  });

  it("keeps the old cutoff for pre-migration attempts that may already have reached PayPal", async () => {
    await db.exec("alter table shop_subscriptions drop column create_started_at; delete from schema_migrations where name = '0074_subscription_create_started.sql'");
    await db.query("insert into shop_subscriptions (shop_id, plan_id, requested_at) values ($1, 'P-TEST', now() - interval '7 hours')", [shopId]);
    await migrate(db, loadMigrations().filter((m) => m.name === "0074_subscription_create_started.sql"));
    const row = await stored();
    expect(row.create_started_at).toEqual(row.requested_at);
    expect(message(await start(post("start")))).toContain("needs checking");
    expect(api.request.mock.calls).toEqual([["GET", "/v1/billing/plans/P-TEST"]]);
  });

  it.each(["ACTIVATED", "CANCELLED", "SUSPENDED", "EXPIRED"])("routes verified BILLING.SUBSCRIPTION.%s and ignores unknown ids", async (kind) => {
    await start(post("start")); reply = { ...reply, status: kind === "ACTIVATED" ? "ACTIVE" : kind };
    const send = async (id: string, signed = true) => {
      const raw = Buffer.from(JSON.stringify({ id: `WH-${kind}-${id}`, event_type: `BILLING.SUBSCRIPTION.${kind}`, resource: { id } }));
      return handleWebhookDelivery({ rawBody: raw, headers: signed ? paypalHeaders(raw, "HOOK", `TX-${id}`) : new Headers(), webhookId: "HOOK", db, recordKey: key, fetchCert: fetchTestCert,
        onSubscriptionChanged: (subscriptionId) => syncSubscriptionEvent(db, api as PayPalClient, { subscriptionId, recordKey: key, secret: SECRET }) });
    };
    expect((await send(subscriptionId, false)).status).toBe(401); expect((await stored()).status).toBe("APPROVAL_PENDING");
    expect((await send(subscriptionId)).status).toBe(200); expect((await stored()).status).toBe(reply.status);
    api.request.mockClear(); expect((await send("I-UNKNOWN")).status).toBe(200); expect(api.request).not.toHaveBeenCalled();
  });

  it("does not route the platform app's events and retries a failed subscription read on redelivery", async () => {
    await start(post("start")); reply = { ...reply, status: "ACTIVE" };
    const raw = Buffer.from(JSON.stringify({ id: "WH-BILLING", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: subscriptionId } }));
    const callback = vi.fn(async (subscriptionId: string) => syncSubscriptionEvent(db, api as PayPalClient, { subscriptionId, recordKey: key, secret: SECRET }));
    const send = (hook = "HOOK") => handleWebhookDelivery({ rawBody: raw, headers: paypalHeaders(raw, hook, `TX-${hook}`), webhookId: "HOOK", db, recordKey: key, fetchCert: fetchTestCert, platform: { webhookId: "PLATFORM" }, onSubscriptionChanged: callback });
    expect((await send("PLATFORM")).status).toBe(200); expect(callback).not.toHaveBeenCalled();
    api.request.mockRejectedValueOnce(new Error("no answer")); await expect(send()).rejects.toThrow("no answer");
    expect((await send()).status).toBe(200); expect((await stored()).status).toBe("ACTIVE");
  });
});
