import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { doorLedgerSale, doorLedgerShop, storedRecall } from "../../test/doorLedger";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { prepareNotice } from "./store";
import { readDoorNotice, recordDoorPrint } from "./door";
import { DoorNotice } from "../../app/queue/door/DoorNotice";
import { receiptQr } from "../safetyReceipt/qr";

describe("door notices", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let noticeId: string;
  let matchId: string;
  const shown = async () => (await readDoorNotice(db, { shopId, noticeId })).version;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await doorLedgerShop(db);
    ({ matchId } = await doorLedgerSale(db, shopId));
    ({ noticeId } = await prepareNotice(db, { shopId, matchId }));
  });

  it("renders the stored CPSC words verbatim, including contact, with no private sale fields", async () => {
    const notice = await readDoorNotice(db, { shopId, noticeId });
    expect(notice.title).toBe(storedRecall.Title);
    expect(notice.hazards).toEqual(storedRecall.Hazards.map((h: { Name: string }) => h.Name));
    expect(notice.remedies).toEqual(storedRecall.Remedies.map((r: { Name: string }) => r.Name));
    expect(notice.consumerContact).toBe(storedRecall.ConsumerContact);
    expect(notice).toMatchObject({ recallNumber: storedRecall.RecallNumber, recallDate: "2022-08-15" });
    const publicUrl = "https://example.test/recall/22200";
    const html = renderToStaticMarkup(createElement(DoorNotice, { notice, noticeId, publicUrl, qr: await receiptQr(publicUrl) }));
    for (const words of [notice.title, ...notice.hazards, ...notice.remedies, notice.consumerContact!]) {
      expect(html).toContain(renderToStaticMarkup(createElement("p", null, words)).slice(3, -4));
    }
    expect(html).toContain("800-638-2772");
    expect(html).toContain("https://example.test/recall/22200");
    expect(html).not.toContain("/r/");
    for (const privateText of ["PRIVATE-ORDER", "PRIVATE-SKU", "PRIVATE-PAYMENT", "123.45", "Shop&#x27;s name for this swing", "buyer_email", "order_number", "unit_price"]) {
      expect(html).not.toContain(privateText);
      expect(JSON.stringify(notice)).not.toContain(privateText);
    }
    expect(html).not.toContain("We sold this item between");
  });

  it("uses only this shop's confirmed sale dates for this recall", async () => {
    await doorLedgerSale(db, shopId, { date: "2022-08-01", order: "LAST" });
    await doorLedgerSale(db, shopId, { date: "2022-01-01", order: "GAP", verdict: "SCOPE_GAP", strength: "BRAND" });
    const other = await createShop(db, { name: "Other shop", kind: "REAL" });
    await doorLedgerSale(db, other, { date: "2021-01-01" });
    expect(await readDoorNotice(db, { shopId, noticeId })).toMatchObject({ firstSale: "2022-07-01", lastSale: "2022-08-01" });
  });

  it("refuses another shop and malformed or missing notices", async () => {
    const other = await createShop(db, { name: "Other shop", kind: "REAL" });
    await expect(readDoorNotice(db, { shopId: other, noticeId })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    await expect(readDoorNotice(db, { shopId, noticeId: "bad" })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    await expect(readDoorNotice(db, { shopId, noticeId: crypto.randomUUID() })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
  });

  it("refuses a sale with email, an unconfirmed match, and changed recall evidence", async () => {
    await db.query("update order_lines set buyer_email_enc = 'private-encrypted-email' where shop_id = $1", [shopId]);
    await expect(readDoorNotice(db, { shopId, noticeId })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    await db.query("update order_lines set buyer_email_enc = null where shop_id = $1", [shopId]);
    await db.query("update recall_matches set strength = 'PRODUCT_WORDS' where id = $1", [matchId]);
    await expect(readDoorNotice(db, { shopId, noticeId })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    await db.query("update recall_matches set strength = 'CONFIRMED', recall_sha256 = 'old' where id = $1", [matchId]);
    await expect(readDoorNotice(db, { shopId, noticeId })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
  });

  it("refuses a check request instead of calling its item recalled", async () => {
    await db.query("update notices set kind = 'CHECK_REQUEST' where id = $1", [noticeId]);
    await expect(readDoorNotice(db, { shopId, noticeId })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
  });

  it("records who and when once per action, and allows a separate print action", async () => {
    const action = { shopId, noticeId, sessionId: "owner-session", actionId: crypto.randomUUID(), version: await shown() };
    const [first, repeat] = await Promise.all([recordDoorPrint(db, action), recordDoorPrint(db, action)]);
    expect(repeat).toBe(first);
    expect(await readDoorNotice(db, { shopId, noticeId })).toMatchObject({ printedAt: first });
    const { rows } = await db.query("select shop_id, session_id, action_id, printed_at from notice_door_prints");
    expect(rows).toEqual([{ shop_id: shopId, session_id: "owner-session", action_id: action.actionId, printed_at: new Date(first) }]);
    await recordDoorPrint(db, { ...action, actionId: crypto.randomUUID() });
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(2);
  });

  it("refuses print writes for another shop, bad ids, and changed evidence", async () => {
    const other = await createShop(db, { name: "Other shop", kind: "REAL" });
    const action = { shopId, noticeId, sessionId: "owner-session", actionId: crypto.randomUUID(), version: await shown() };
    await expect(recordDoorPrint(db, { ...action, shopId: other })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    await expect(recordDoorPrint(db, { ...action, actionId: "bad" })).rejects.toMatchObject({ code: "NO_ANSWER" });
    await db.query("update recall_matches set verdict = 'CLEARED' where id = $1", [matchId]);
    await expect(recordDoorPrint(db, action)).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(0);
  });

  it("refuses a new print of a notice that already went out once CPSC changed the recall", async () => {
    const action = { shopId, noticeId, sessionId: "owner-session", actionId: crypto.randomUUID(), version: await shown() };
    await db.query("update notices set sent_at = now() where id = $1", [noticeId]);
    await db.query("update recall_matches set recall_sha256 = 'old' where id = $1", [matchId]);
    await expect(readDoorNotice(db, { shopId, noticeId })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    await expect(recordDoorPrint(db, action)).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(0);
  });

  it.each([
    ["two possible orders", "update recall_matches set join_state = 'AMBIGUOUS_JOIN' where id = $1"],
    ["weaker evidence", "update recall_matches set strength = 'PRODUCT_WORDS' where id = $1"],
    ["a recall CPSC changed", "update recall_matches set recall_sha256 = 'old' where id = $1"],
  ])("refuses a retried print action once the card has %s, though the first try was recorded", async (_name, change) => {
    const action = { shopId, noticeId, sessionId: "owner-session", actionId: crypto.randomUUID(), version: await shown() };
    await recordDoorPrint(db, action);
    await db.query(change, [matchId]);
    await expect(recordDoorPrint(db, action)).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
  });

  it("refuses a print of words that are no longer CPSC's, even when the card was rechecked", async () => {
    const onScreen = await shown();
    await db.query("update recalls set raw_sha256 = 'newer-words'");
    await db.query("update recall_matches set recall_sha256 = 'newer-words' where id = $1", [matchId]);
    expect(await shown()).toBe("newer-words");
    await expect(recordDoorPrint(db, { shopId, noticeId, sessionId: "owner-session", actionId: crypto.randomUUID(), version: onScreen })).rejects.toMatchObject({ code: "NO_SUCH_NOTICE" });
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(0);
  });

  it("deletes the print history with the notice or the shop", async () => {
    const action = { shopId, noticeId, sessionId: "owner-session", actionId: crypto.randomUUID(), version: await shown() };
    await recordDoorPrint(db, action);
    await db.query("delete from notices where id = $1", [noticeId]);
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(0);
    ({ noticeId } = await prepareNotice(db, { shopId, matchId }));
    await recordDoorPrint(db, { ...action, noticeId });
    await db.query("delete from shops where id = $1", [shopId]);
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(0);
  });

  it("does not invent missing consumer contact details", async () => {
    await db.query("update recalls set raw = raw - 'ConsumerContact'");
    expect((await readDoorNotice(db, { shopId, noticeId })).consumerContact).toBeNull();
  });
});
