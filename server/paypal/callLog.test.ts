import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { callsBelongTo, readCalls, withCallLog } from "./callLog";
import { createPayPalClient, PayPalApiError } from "./client";

const tokens = { get: async () => "token", invalidate: () => {} };
const answering = (status: number, body: object, headers: Record<string, string> = { "paypal-debug-id": "dbg123" }) =>
  createPayPalClient({ tokens, sleep: async () => {}, fetchImpl: (async () => new Response(JSON.stringify(body), { status, headers })) as typeof fetch });

describe("what this app asked PayPal", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "Shop", kind: "DEMO" });
  });
  afterEach(async () => {
    await db.close();
  });

  it("keeps the call's shape and PayPal's debug id, with the id out of the path", async () => {
    await withCallLog(db, shopId, () => answering(200, { id: "RAWID" }).request("GET", "/v2/payments/captures/RAWCAPTUREID1"));
    const [call, ...rest] = await readCalls(db, shopId);
    expect(rest).toEqual([]);
    expect(call).toMatchObject({ method: "GET", template: "/v2/payments/captures/:id", status: 200, debugId: "dbg123" });
    expect(call.ms).toBeGreaterThanOrEqual(0);
  });

  it("keeps no payload, no query and no id anywhere in the row", async () => {
    const client = answering(201, { id: "RAWORDERID", payer: { email_address: "family@example.test" } });
    await withCallLog(db, shopId, async () => {
      await client.request("POST", "/v2/checkout/orders", { body: { secret: "RAWBODY" } });
      await client.request("GET", "/v1/reporting/transactions", { query: { start_date: "RAWDATE" } });
    });
    const { rows } = await db.query("select * from paypal_calls");
    expect(JSON.stringify(rows)).not.toMatch(/RAW|family@/);
    expect(rows).toHaveLength(2);
  });

  it("logs a call PayPal refused, and still raises it", async () => {
    await expect(
      withCallLog(db, shopId, () => answering(422, { name: "UNPROCESSABLE_ENTITY" }).request("POST", "/v2/payments/captures/RAWCAPTUREID1/refund")),
    ).rejects.toBeInstanceOf(PayPalApiError);
    expect(await readCalls(db, shopId)).toMatchObject([{ method: "POST", template: "/v2/payments/captures/:id/refund", status: 422 }]);
  });

  it("gives newest first, and only to the shop that made them", async () => {
    const other = await createShop(db, { name: "Other", kind: "DEMO" });
    await withCallLog(db, shopId, async () => {
      await answering(200, {}).request("GET", "/v2/checkout/orders/RAWA");
      await answering(200, {}).request("GET", "/v2/payments/captures/RAWB");
    });
    expect((await readCalls(db, shopId)).map((c) => c.template)).toEqual(["/v2/payments/captures/:id", "/v2/checkout/orders/:id"]);
    expect(await readCalls(db, other)).toEqual([]);
  });

  it("keeps nothing for a call made outside a log", async () => {
    await answering(200, {}).request("GET", "/v2/checkout/orders/RAWA");
    expect((await db.query("select 1 from paypal_calls")).rows).toEqual([]);
  });

  it("can learn the shop partway through, as a webhook does", async () => {
    await withCallLog(db, null, async () => {
      await answering(200, {}).request("GET", "/v2/payments/captures/RAWA");
      callsBelongTo(shopId);
    });
    expect(await readCalls(db, shopId)).toHaveLength(1);
  });

  it("keeps nothing if no shop is ever named", async () => {
    await withCallLog(db, null, () => answering(200, {}).request("GET", "/v2/payments/captures/RAWA"));
    expect((await db.query("select 1 from paypal_calls")).rows).toEqual([]);
  });

  it("never costs the action if the log can't be written", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { query: async () => Promise.reject(new Error("down")) } as unknown as typeof db;
    await expect(withCallLog(broken, shopId, async () => { await answering(200, {}).request("GET", "/v2/orders/RAWA"); return "done"; })).resolves.toBe("done");
    expect(error.mock.calls.flat().join(" ")).not.toContain("RAWA");
    error.mockRestore();
  });

  it("goes when the shop goes", async () => {
    await withCallLog(db, shopId, () => answering(200, {}).request("GET", "/v2/payments/captures/RAWA"));
    await db.query("delete from shops where id = $1", [shopId]);
    expect((await db.query("select 1 from paypal_calls")).rows).toEqual([]);
  });
});
