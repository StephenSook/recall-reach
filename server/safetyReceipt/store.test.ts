import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { loadMigrations, migrate } from "../db/migrate";
import { pullRecalls } from "../cpsc/pull";
import { createShop, storeOrderLines } from "../import/store";
import { purgeOldDemoShops } from "../import/ownFile";
import { runShopCheck } from "../match/run";
import { checkStoredShops } from "../match/sweep";
import { loadQueue, toCards } from "../queue/queue";
import { composeForSeller, familyView, prepareNotice } from "../notice/store";
import { createContactCipher } from "../privacy/contactCipher";
import { checkRecordWithClaude } from "../agent/checkRecord";
import { runAgentOnRecord } from "../agent/recallAgent";
import { appJobs } from "../jobs/appJobs";
import { approveRefund } from "../paypal/refunds";
import type { PayPalClient } from "../paypal/client";
import { pushNewCards, registerPushToken } from "../push/push";
import { createReceipt, deleteReceipt, deleteShopReceipt, purgeReceipts, receiptShop, shopReceiptLink } from "./store";

const SECRET = "k".repeat(32);
const EMAIL = "FAMILY-PRIVATE-SENTINEL@example.test";
const NOW = new Date("2026-11-07T12:00:00Z");
const input = { item: "SuperFast Sterilizer Dryer", brand: "Baby Brezza", model: "BRZ0083", email: EMAIL, consent: true, website: "" };
const fixture = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");

describe("family-given safety receipts", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  const save = (over = {}) => createReceipt(db, shopId, { ...input, ...over }, SECRET, NOW);
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "Our shop", kind: "REAL" });
  });
  afterEach(async () => { vi.restoreAllMocks(); await db.close(); });

  const loadRecalls = () => pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, {
    fetchImpl: (async () => new Response(fixture, { headers: { "content-type": "application/json" } })) as typeof fetch,
  });

  it("upgrades an existing shop and notice without losing their records", async () => {
    db = await testDb();
    await migrate(db, loadMigrations().filter((m) => m.name < "0066"));
    shopId = await createShop(db, { name: "Existing shop", kind: "REAL" });
    await loadRecalls();
    await db.query(`insert into order_lines (shop_id, order_number, line_no, title, quantity, unit_price_cents, currency, ordered_on, source)
      values ($1, 'EXISTING', 1, 'Baby Brezza SuperFast Sterilizer Dryer BRZ0083', 1, 100, 'USD', '2026-09-01', 'test')`, [shopId]);
    await db.query(`insert into recall_matches (shop_id, recall_id, recall_sha256, order_line_id, verdict, strength, matched, missing, reason)
      select l.shop_id, r.recall_id, r.raw_sha256, l.id, 'MATCH', 'CONFIRMED', '[]', '[]', 'test'
      from order_lines l cross join recalls r where r.recall_number = '27072'`, []);
    await db.query(`insert into notices (shop_id, match_id, kind, order_line_id)
      select shop_id, id, 'SAFETY_NOTICE', order_line_id from recall_matches`);
    expect(await migrate(db)).toEqual(["0066_safety_receipts.sql"]);
    const queue = await loadQueue(db, shopId, "owner");
    expect(queue.rows[0]).toMatchObject({ familyAsked: false, notice: { kind: "SAFETY_NOTICE" } });
    await save();
    expect((await db.query("select * from notices")).rows).toHaveLength(1);
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(1);
  });

  it("resolves the signed shop link without placing its id in the token", async () => {
    const token = await shopReceiptLink(db, shopId, SECRET);
    expect(token).not.toContain(shopId);
    expect(await receiptShop(db, token!, SECRET)).toMatchObject({ id: shopId, kind: "REAL" });
    expect(await receiptShop(db, (token![0] === "A" ? "B" : "A") + token!.slice(1), SECRET)).toBeNull();
    await db.query("delete from shops where id = $1", [shopId]);
    expect(await receiptShop(db, token!, SECRET)).toBeNull();
  });

  it("requires explicit consent before storing any personal data", async () => {
    await expect(save({ consent: false })).rejects.toThrow("CONSENT");
    await expect(save({ consent: "true" })).rejects.toThrow("CONSENT");
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(0);
  });

  it("rejects the honeypot and invalid or oversized fields", async () => {
    for (const over of [{ website: "bot" }, { item: " " }, { email: "no address" }, { email: "a@b.test\r\nBcc:x@y.test" }, { model: "x".repeat(121) }]) {
      await expect(save(over)).rejects.toThrow();
    }
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(0);
  });

  it("stores only ciphertext and a delete-token hash, using the existing shop cipher", async () => {
    const saved = await save();
    const row = (await db.query<{ email_enc: string; delete_token_hash: string }>("select email_enc, delete_token_hash from safety_receipts where id = $1", [saved.id])).rows[0];
    expect(JSON.stringify(row)).not.toContain(EMAIL);
    expect(row.delete_token_hash).toBe(createHash("sha256").update(saved.deleteToken).digest("hex"));
    expect(createContactCipher(SECRET, shopId).open(row.email_enc)).toBe(EMAIL);
    expect(() => createContactCipher(SECRET, "another-shop").open(row.email_enc)).toThrow();
  });

  it("deletes once and only the row whose random token was given", async () => {
    const a = await save();
    const b = await save();
    expect(a.deleteToken).not.toBe(b.deleteToken);
    expect(await deleteReceipt(db, a.deleteToken)).toBe(true);
    expect(await deleteReceipt(db, a.deleteToken)).toBe(false);
    expect(await deleteReceipt(db, "wrong")).toBe(false);
    expect((await db.query<{ id: string }>("select id from safety_receipts")).rows).toEqual([{ id: b.id }]);
  });

  it("lets only the owning shop delete a receipt", async () => {
    const a = await save();
    const other = await createShop(db, { name: "Other", kind: "REAL" });
    expect(await deleteShopReceipt(db, other, a.id)).toBe(false);
    expect(await deleteShopReceipt(db, shopId, a.id)).toBe(true);
  });

  it("purges at three calendar years and keeps newer entries", async () => {
    const old = await save();
    const fresh = await save();
    await db.query("update safety_receipts set created_at = '2023-11-07T12:00:00Z' where id = $1", [old.id]);
    await db.query("update safety_receipts set created_at = '2023-11-07T13:00:01Z' where id = $1", [fresh.id]);
    expect(await purgeReceipts(db, NOW)).toBe(1);
    expect((await db.query<{ id: string }>("select id from safety_receipts")).rows).toEqual([{ id: fresh.id }]);
  });

  it("uses the receipt's anniversary for a leap-day entry", async () => {
    const saved = await save();
    await db.query("update safety_receipts set created_at = '2024-02-29T12:00:00Z' where id = $1", [saved.id]);
    expect(await purgeReceipts(db, new Date("2027-02-28T12:00:00Z"))).toBe(1);
  });

  it("purges demo receipts with their shop and cascades on a real shop deletion", async () => {
    const demo = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    await createReceipt(db, demo, input, SECRET, NOW);
    await db.query("update shops set created_at = '2026-11-01' where id = $1", [demo]);
    await save();
    expect(await purgeOldDemoShops(db, NOW)).toBe(1);
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(1);
    await db.query("delete from shops where id = $1", [shopId]);
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(0);
  });

  it("runs receipt retention from the hourly job even if CPSC is unavailable", async () => {
    const saved = await save();
    await db.query("update safety_receipts set created_at = '2023-11-06' where id = $1", [saved.id]);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const job = appJobs(db, { now: () => NOW, fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch, sleep: async () => {} })[0];
    await expect(job.run()).rejects.toThrow();
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(0);
  });

  it("rolls the receipt back when its initial match fails", async () => {
    await db.exec("drop table recall_matches cascade");
    // No candidate means no insert; load an actual recall to exercise the failing match write.
    await loadRecalls();
    await expect(save()).rejects.toThrow();
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(0);
  });

  it("refuses refunds through the existing payment rules and at the database boundary", async () => {
    await loadRecalls();
    await save();
    const row = (await loadQueue(db, shopId, "owner")).rows.find((r) => r.recallNumber === "27072")!;
    const request = vi.fn();
    await expect(approveRefund(db, { request } as PayPalClient, { shopId, sessionId: "owner", matchId: row.matchId })).rejects.toThrow("No such match");
    expect(request).not.toHaveBeenCalled();
    await expect(db.query("update recall_matches set sale_path = 'REFUND_ELIGIBLE' where id = $1", [row.matchId])).rejects.toThrow();
    expect((await db.query("select * from approvals")).rows).toHaveLength(0);
  });

  it("uses the matcher and existing queue card, with a family label and no refund path", async () => {
    await loadRecalls();
    const saved = await save();
    const queue = await loadQueue(db, shopId, "owner");
    const card = toCards(queue.rows).cards.find((c) => c.lead.recallNumber === "27072");
    expect(card?.lead).toMatchObject({ recordId: saved.id, familyAsked: true, verdict: "MATCH", salePath: null, joinState: null, approval: null, refund: null, source: "A family asked to hear about this" });
    expect(JSON.stringify(queue)).not.toContain(EMAIL);
    expect((await db.query("select * from order_lines")).rows).toHaveLength(0);
  });

  it("checks a receipt when a new recall arrives through the normal shop sweep", async () => {
    await save();
    await loadRecalls();
    expect((await checkStoredShops(db, { now: NOW })).shopsChecked).toBe(1);
    expect((await loadQueue(db, shopId, "owner")).rows.some((r) => r.familyAsked && r.recallNumber === "27072")).toBe(true);
  });

  it("labels a receipt as a receipt in a shop push and includes no family data", async () => {
    await loadRecalls();
    await save();
    const row = (await loadQueue(db, shopId, "owner")).rows.find((r) => r.recallNumber === "27072")!;
    await registerPushToken(db, shopId, "ExponentPushToken[testReceipt]");
    const bodies: string[] = [];
    const sent = await pushNewCards(db, shopId, [row.matchId], (async (_url, init) => {
      bodies.push(String(init?.body));
      return Response.json({ data: [{ status: "ok" }] });
    }) as typeof fetch);
    expect(sent).toBe(1);
    expect(bodies[0]).toContain("safety receipt");
    expect(bodies[0]).not.toContain("something you sold");
    expect(bodies[0]).not.toContain(EMAIL);
    expect(bodies[0]).not.toContain(input.item);
  });

  it("prepares the normal notice for the owner, with the family's address and no invented sale date", async () => {
    await loadRecalls();
    const saved = await save();
    const row = (await loadQueue(db, shopId, "owner")).rows.find((r) => r.recallNumber === "27072")!;
    const notice = await prepareNotice(db, { shopId, matchId: row.matchId });
    expect(notice.kind).toBe("SAFETY_NOTICE");
    const message = await composeForSeller(db, { shopId, noticeId: notice.noticeId, baseUrl: "https://example.test", tokenSecret: SECRET, cipher: createContactCipher(SECRET, shopId) });
    expect(message.to).toBe(EMAIL);
    expect(message.toSource).toBe("Safety receipt");
    expect(message.body).toContain("You asked to hear about");
    expect(message.body).not.toContain("You bought");
    expect(message.body).not.toContain("PayPal confirmed a refund");
    expect(await familyView(db, notice.noticeId)).toMatchObject({ kind: "SAFETY_NOTICE" });
    await expect(composeForSeller(db, { shopId: "00000000-0000-4000-8000-000000000000", noticeId: notice.noticeId, baseUrl: "https://example.test", tokenSecret: SECRET, cipher: createContactCipher(SECRET, shopId) })).rejects.toThrow();
    await deleteReceipt(db, saved.deleteToken);
    expect((await db.query("select * from recall_matches")).rows).toHaveLength(0);
    expect((await db.query("select * from notices")).rows).toHaveLength(0);
  });

  it("never sends the family's email or text to the Claude client or logs", async () => {
    await loadRecalls();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    const saved = await save({ item: input.item + " " + EMAIL });
    const requests: string[] = [];
    const client = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: (async (_url, init) => {
      requests.push(String(init?.body));
      const turn = JSON.parse(String(init?.body));
      const hasResults = JSON.stringify(turn.messages).includes('"tool_result"');
      const content = hasResults ? [] : [
        { type: "tool_use", id: "read", name: "read_shop_item", input: { item_id: "item-1" } },
        { type: "tool_use", id: "search", name: "search_shop_items", input: { query: "Baby Brezza" } },
        { type: "tool_use", id: "private", name: "read_shop_item", input: { item_id: saved.id } },
      ];
      return Response.json({ id: "msg-test", type: "message", role: "assistant", model: "test", content, stop_reason: hasResults ? "end_turn" : "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch });
    await checkRecordWithClaude(db, client, { shopId, recordId: saved.id, now: NOW });
    expect(requests).toHaveLength(0);
    // A real shop-owned line exercises the SDK wire while private receipts exist in the same shop.
    await storeOrderLines(db, shopId, [{ orderNumber: "OWN-1", lineNo: 1, title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", sku: null, quantity: 1, unitPriceCents: 100, discountCents: 0, currency: "USD", orderedOn: "2026-09-01", paymentReference: null, buyerEmail: null }], createContactCipher(SECRET, shopId), "test");
    await runShopCheck(db, shopId, { today: "2026-11-07" });
    const id = (await db.query<{ id: string }>("select id from order_lines")).rows[0].id;
    await runAgentOnRecord(db, client, { shopId, recordId: id, now: NOW });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some((r) => r.includes('"tool_result"'))).toBe(true);
    expect(requests.join("\n")).toContain("Baby Brezza SuperFast Sterilizer Dryer BRZ0083");
    expect(requests.join("\n")).not.toContain(EMAIL);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(EMAIL);
  });
});
