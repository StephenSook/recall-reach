import { parse } from "csv-parse/sync";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { doorLedgerSale, doorLedgerShop, storedRecall } from "../../test/doorLedger";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { purgePayPalData } from "../privacy/retention";
import { PAST_WINDOW_SAMPLE } from "./payouts";
import { maskedPayPalId, readSentLedger, SENT_COLUMNS, sentCells, sentLedgerCsv } from "./sentLedger";

describe("refunds sent ledger", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await doorLedgerShop(db);
  });

  async function refund(shop = shopId, status = "refunded", date = "2026-11-06T12:00:00Z", order = "PRIVATE-ORDER") {
    const { lineId } = await doorLedgerSale(db, shop, { order, email: "private-buyer@example.test" });
    const { rows: approvals } = await db.query<{ id: string }>(
      `insert into approvals (shop_id, session_id, recall_id, recall_sha256, order_line_id, amount_cents, currency, expires_at)
       select $1, 'owner-session', recall_id, raw_sha256, $2, 12345, 'USD', now() + interval '1 hour'
       from recalls where recall_number = $3 returning id`, [shop, lineId, storedRecall.RecallNumber],
    );
    const { rows } = await db.query<{ id: string }>(
      `insert into refunds (approval_id, shop_id, order_line_id, amount_cents, currency, status, refund_ref_hmac, created_at)
       values ($1, $2, $3, 12345, 'USD', $4, $5, $6) returning id`,
      [approvals[0].id, shop, lineId, status, `hash-${order}-${shop}`, date],
    );
    await db.query("insert into paypal_refund_refs (refund_row_id, capture_id, refund_id, received_at) values ($1, 'PRIVATE-CAPTURE', 'TEST-REFUND-PRIVATE-ENDS', $2)", [rows[0].id, date]);
    await db.query(
      `insert into paypal_webhook_events (event_id_hmac, event_type, resource_id_hmac, resource_status, verification_method, received_at)
       values ($1, 'PAYMENT.CAPTURE.REFUNDED', $2, 'COMPLETED', 'self', $3)`,
      [`event-${order}-${shop}`, `hash-${order}-${shop}`, date],
    );
    return rows[0].id;
  }

  async function payout(shop = shopId, status = "paid", sampleKey: string = PAST_WINDOW_SAMPLE.key) {
    const { rows } = await db.query<{ id: string }>(
      `insert into payouts (shop_id, session_id, sample_key, receiver_enc, amount_cents, currency, status, paypal_status, expires_at, created_at, updated_at)
       values ($1, 'owner-session', $2, 'PRIVATE-RECEIVER', 2400, 'USD', $3, 'SUCCESS', now() + interval '1 hour', '2026-11-07T12:00:00Z', '2026-11-07T12:00:00Z') returning id`,
      [shop, sampleKey, status],
    );
    await db.query("insert into paypal_payout_refs (payout_row_id, batch_id, received_at) values ($1, 'TEST-BATCH-PRIVATE-ENDS', '2026-11-07T12:00:00Z')", [rows[0].id]);
    return rows[0].id;
  }

  it("shows only this shop's requests, newest first, with masked ids and existing links", async () => {
    const id = await refund();
    await payout();
    const other = await createShop(db, { name: "Other shop", kind: "DEMO" });
    await refund(other);
    await payout(other);
    const rows = await readSentLedger(db, shopId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "Payout", item: `Demo sale: ${PAST_WINDOW_SAMPLE.title}`, recallNumber: PAST_WINDOW_SAMPLE.recallNumber, paypalStatus: "SUCCESS", paypalId: "TEST...ENDS", href: "/queue#past-window" });
    expect(rows[1]).toMatchObject({ kind: "Refund", item: "Shop's name for this swing", recallNumber: storedRecall.RecallNumber, amount: "123.45", currency: "USD", paypalStatus: "COMPLETED", paypalId: "TEST...ENDS", href: `/queue/refunds/${id}` });
    expect(rows.map((r) => r.date)).toEqual(["2026-11-07T12:00:00.000Z", "2026-11-06T12:00:00.000Z"]);
  });

  it("uses the most recently received stored PayPal status, not the app's mapped status", async () => {
    await refund();
    await db.query("update paypal_webhook_events set resource_status = 'PENDING'");
    expect((await readSentLedger(db, shopId))[0].paypalStatus).toBe("PENDING");
    await db.query(`insert into paypal_webhook_events (event_id_hmac, event_type, resource_id_hmac, resource_status, verification_method, received_at)
      select 'newer-event', event_type, resource_id_hmac, 'CANCELLED', 'self', received_at + interval '1 hour' from paypal_webhook_events`);
    expect((await readSentLedger(db, shopId))[0].paypalStatus).toBe("CANCELLED");
  });

  it("matches the CSV to the table fields and excludes buyer data and complete PayPal ids", async () => {
    await refund();
    await payout();
    const rows = await readSentLedger(db, shopId);
    const csv = sentLedgerCsv(rows);
    expect(parse(csv)).toEqual([SENT_COLUMNS, ...rows.map(sentCells)]);
    for (const value of ["private-buyer", "PRIVATE-ORDER", "PRIVATE-CAPTURE", "PRIVATE-RECEIVER", "TEST-REFUND-PRIVATE-ENDS", "TEST-BATCH-PRIVATE-ENDS", "buyer_email", "receiver_enc"]) {
      expect(csv).not.toContain(value);
      expect(JSON.stringify(rows)).not.toContain(value);
    }
  });

  it("keeps own ledger rows after the PayPal purge and does not reconstruct purged ids or statuses", async () => {
    await refund();
    await payout();
    await purgePayPalData(db, new Date("2026-11-10T12:00:00Z"));
    const rows = await readSentLedger(db, shopId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.paypalId === "Not held here")).toBe(true);
    expect(rows.find((r) => r.kind === "Refund")?.paypalStatus).toBe("Not held here (our record: refunded)");
    expect(rows.find((r) => r.kind === "Payout")?.paypalStatus).toBe("Not held here (our record: paid)");
  });

  it("omits approvals, reservations and refunds explicitly recorded as never sent", async () => {
    await refund(shopId, "reserved", undefined, "RESERVED");
    const failed = await refund(shopId, "failed", undefined, "NEVER-SENT");
    await db.query("update refunds set failure = 'Never sent to PayPal.' where id = $1", [failed]);
    await payout(shopId, "reviewed");
    expect(await readSentLedger(db, shopId)).toEqual([]);
  });

  it("does not guess a sale or recall for an unknown payout sample key", async () => {
    await payout(shopId, "unconfirmed", "unknown-sample");
    expect((await readSentLedger(db, shopId))[0]).toMatchObject({ item: "Item not held here", recallNumber: "Not held here" });
  });

  it("returns an empty list and a header-only CSV when nothing was sent", async () => {
    expect(await readSentLedger(db, shopId)).toEqual([]);
    expect(parse(sentLedgerCsv([]))).toEqual([SENT_COLUMNS]);
  });

  it("quotes CSV text and neutralizes spreadsheet formulas", async () => {
    await refund();
    const rows = await readSentLedger(db, shopId);
    rows[0].item = '  =HYPERLINK("bad")\nnext';
    expect(parse(sentLedgerCsv(rows))[1][2]).toBe(`'${rows[0].item}`);
    for (const prefix of ["+", "-", "@", "\t="]) {
      rows[0].item = `${prefix}formula`;
      expect(parse(sentLedgerCsv(rows))[1][2]).toBe(`'${rows[0].item}`);
    }
  });

  it("masks the middle and fully hides short ids", () => {
    expect(maskedPayPalId("TEST-REFUND-PRIVATE-ENDS")).toBe("TEST...ENDS");
    expect(maskedPayPalId("SHORT")).toBe("[hidden]");
    expect(maskedPayPalId(null)).toBe("Not held here");
  });
});
