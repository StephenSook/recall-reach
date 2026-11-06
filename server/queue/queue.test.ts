import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { seedDemoShop } from "../demo/seed";
import { createShop } from "../import/store";
import { markOpened, markSent, prepareNotice, recordFamilyStopped } from "../notice/store";
import type { Method, PayPalClient, RequestOptions } from "../paypal/client";
import { approveRefund } from "../paypal/refunds";
import { loadQueue, tellCpscDraft, toCards, type QueueRow } from "./queue";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";

function fakePayPal(): PayPalClient {
  const orders = new Map<string, unknown>();
  return {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      if (method === "POST") {
        const id = `RAWORDERID${orders.size}`;
        const unit = (opts.body as { purchase_units: { amount: unknown }[] }).purchase_units[0];
        const capture = { id: `RAWCAPTUREID${orders.size}`, status: "COMPLETED", create_time: `${TODAY}T14:00:00Z`, amount: unit.amount };
        orders.set(capture.id, capture);
        orders.set(id, { id, status: "COMPLETED", purchase_units: [{ ...unit, payments: { captures: [capture] } }] });
        return { status: 201, data: { id } };
      }
      return { status: 200, data: orders.get(path.split("/").pop() ?? "") };
    }) as PayPalClient["request"],
  };
}

describe("loadQueue", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let paypal: PayPalClient;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    paypal = fakePayPal();
    ({ shopId } = await seedDemoShop(db, paypal, { today: TODAY, secret: "k".repeat(32) }));
  });
  afterEach(async () => {
    await db.close();
  });

  const row = async (recallNumber: string) => {
    const q = await loadQueue(db, shopId, "session-1");
    const found = q.rows.find((r) => r.recallNumber === recallNumber);
    if (!found) throw new Error(`no row for ${recallNumber}`);
    return found;
  };

  it("lists each case with the recall, the item, verdict, path, join and evidence", async () => {
    expect(await row("27072")).toMatchObject({
      recallTitle: expect.stringMatching(/^Baby Brezza/),
      itemTitle: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083",
      verdict: "MATCH",
      salePath: "NOTICE_ONLY",
      joinState: "IDENTIFIED",
      source: expect.stringMatching(/seeded/),
      notice: null,
      refund: null,
      approval: null,
    });
    expect((await row("27072")).matched).toContain("model: BRZ0083");
    expect(await row("27040")).toMatchObject({ verdict: "SCOPE_GAP", missing: [expect.any(String)] });
  });

  it("says which sale each row is about and how strong the evidence is, so sales stay apart on the page", async () => {
    const { rows } = await loadQueue(db, shopId, "session-1");
    const { rows: lines } = await db.query<{ id: string }>("select id from order_lines where shop_id = $1", [shopId]);
    const ids = lines.map((l) => l.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(ids).toContain(r.recordId);
    expect(new Set(rows.map((r) => r.recordId)).size).toBeGreaterThan(1);
    expect(rows.find((r) => r.verdict === "MATCH")?.strength).toBe("CONFIRMED");
  });

  it("shows any row with no recorded strength as weak, until the check runs again", async () => {
    await db.query("update recall_matches set strength = null where shop_id = $1", [shopId]);
    expect((await row("27040")).strength).toBe("PRODUCT_WORDS");
    expect((await row("27072")).strength).toBe("PRODUCT_WORDS");
  });

  it("orders what needs a person first: matches, then gaps, then cleared", async () => {
    const q = await loadQueue(db, shopId, "session-1");
    const order = q.rows.map((r) => r.verdict);
    expect(order).toEqual([...order].sort((a, b) => ["MATCH", "SCOPE_GAP", "CLEARED"].indexOf(a) - ["MATCH", "SCOPE_GAP", "CLEARED"].indexOf(b)));
  });

  it("links each demo sale to the capture the seed made, with PayPal's history not searched", async () => {
    const q = await loadQueue(db, shopId, "session-1");
    expect(q.coverage?.paypalSearched).toBe(false);
    expect(q.rows.length).toBeGreaterThanOrEqual(3);
    for (const r of q.rows) expect(r.joinState, r.recallNumber).toBe("IDENTIFIED");
  });

  it("carries the run's coverage", async () => {
    const q = await loadQueue(db, shopId, "session-1");
    expect(q.coverage).toMatchObject({ recallsChecked: 55, searchedTo: TODAY, unidentifiedPayments: 0, paypalSearched: false, candidatesNotChecked: 0 });
    expect(q.shop).toEqual({ name: "DEMO SHOP", kind: "DEMO" });
  });

  it("shows the notice's state and the family's report", async () => {
    const { matchId } = await row("27072");
    const { noticeId } = await prepareNotice(db, { shopId, matchId });
    expect((await row("27072")).notice).toMatchObject({ id: noticeId, kind: "SAFETY_NOTICE", state: "PREPARED", stopped: false });
    await markOpened(db, { shopId, noticeId });
    expect((await row("27072")).notice?.state).toBe("OPENED_IN_MAIL");
    await recordFamilyStopped(db, noticeId);
    expect((await row("27072")).notice).toMatchObject({ state: "FAMILY_RESPONDED", stopped: true });
  });

  it("shows a pending approval only to the session that made it", async () => {
    const { matchId } = await row("27027");
    const a = await approveRefund(db, paypal, { shopId, sessionId: "session-1", matchId });
    expect((await row("27027")).approval).toMatchObject({ id: a.approvalId, amountCents: 9000, currency: "USD" });
    const other = await loadQueue(db, shopId, "session-2");
    expect(other.rows.find((r) => r.recallNumber === "27027")?.approval).toBeNull();
  });

  it("carries no raw PayPal id to the page", async () => {
    const q = JSON.stringify(await loadQueue(db, shopId, "session-1"));
    expect(q).not.toContain("RAWORDERID");
    expect(q).not.toContain("RAWCAPTUREID");
  });

  it("shows nothing for a shop with no records, and says no recall matched only with full coverage", async () => {
    const empty = await createShop(db, { name: "EMPTY", kind: "DEMO" });
    expect(await loadQueue(db, empty, "s")).toMatchObject({ rows: [], coverage: null });
  });

  describe("a sale with a question and then a safety notice", () => {
    const untilConfirmed = async () => {
      await db.query("update recall_matches set verdict = 'SCOPE_GAP', strength = 'BRAND' where recall_id = (select recall_id from recalls where recall_number = '27072') and shop_id = $1", [shopId]);
      const { matchId } = await row("27072");
      const asked = await prepareNotice(db, { shopId, matchId });
      await markSent(db, { shopId, noticeId: asked.noticeId });
      await db.query("update recall_matches set verdict = 'MATCH', strength = 'CONFIRMED' where id = $1", [matchId]);
      return { matchId, asked };
    };

    it("is one row, showing the question until the seller approves the notice", async () => {
      const { asked } = await untilConfirmed();
      const rows = (await loadQueue(db, shopId, "session-1")).rows.filter((r) => r.recallNumber === "27072");
      expect(rows).toHaveLength(1);
      expect(rows[0].notice).toMatchObject({ id: asked.noticeId, kind: "CHECK_REQUEST" });
    });

    it("is still one row after that, showing the notice, and keeps what the family said", async () => {
      const { matchId, asked } = await untilConfirmed();
      await db.query("update notices set check_result = 'MATCHES', responded_at = now() where id = $1", [asked.noticeId]);
      const notice = await prepareNotice(db, { shopId, matchId });
      const rows = (await loadQueue(db, shopId, "session-1")).rows.filter((r) => r.recallNumber === "27072");
      expect(rows).toHaveLength(1);
      expect(rows[0].notice).toMatchObject({ id: notice.noticeId, kind: "SAFETY_NOTICE", state: "PREPARED" });
      expect(rows[0].earlierQuestionResult).toBe("MATCHES");
    });

    it("has no earlier answer when there was no question", async () => {
      const { matchId } = await row("27072");
      await prepareNotice(db, { shopId, matchId });
      expect((await row("27072")).earlierQuestionResult).toBeNull();
    });
  });
});

describe("toCards", () => {
  const row = (recallNumber: string, over: Partial<QueueRow> = {}): QueueRow => ({
    matchId: `m-${recallNumber}`,
    recordId: "line-1",
    recallNumber,
    recallTitle: "t",
    recallDate: "2026-01-01",
    recallUrl: "u",
    product: "p",
    itemTitle: "Costway high chair",
    source: "s",
    orderedOn: "2026-09-22",
    verdict: "SCOPE_GAP",
    strength: "PRODUCT_WORDS",
    salePath: "REFUND_ELIGIBLE",
    joinState: "IDENTIFIED",
    matched: [],
    missing: [],
    reason: "r",
    isListing: false,
    stillListed: false,
    notice: null,
    earlierQuestionResult: null,
    approval: null,
    refund: null,
    ...over,
  });

  it("gives one sale one card, however many recalls it could belong to", () => {
    const { cards } = toCards([row("25206"), row("25278"), row("26290"), row("27040", { strength: "BRAND" })]);
    expect(cards).toHaveLength(1);
    expect(cards[0].lead.recallNumber).toBe("27040");
    expect(cards[0].also.map((r) => r.recallNumber).sort()).toEqual(["25206", "25278", "26290"]);
  });

  it("leads with the strongest candidate, and the newest recall among equals", () => {
    const { cards } = toCards([
      row("25166", { strength: "BRAND", recallDate: "2025-02-27" }),
      row("27040", { strength: "BRAND", recallDate: "2026-10-22" }),
      row("25222", { strength: "BRAND", recallDate: "2025-04-10" }),
    ]);
    expect(cards[0].lead.recallNumber).toBe("27040");
    expect(cards[0].also.map((r) => r.recallNumber)).toEqual(["25222", "25166"]);
  });

  it("keeps weak candidates visible, and never turns them into cleared rows", () => {
    const { cards, cleared } = toCards([row("25206"), row("26290")]);
    expect(cards).toHaveLength(1);
    expect(cards[0].lead.verdict).toBe("SCOPE_GAP");
    expect(cleared).toEqual([]);
  });

  it("gives two different sales two cards", () => {
    expect(toCards([row("27040"), row("27040", { recordId: "line-2", matchId: "m2" })]).cards).toHaveLength(2);
  });

  it("gives every confirmed recall on a sale its own card, because each is a separate hazard", () => {
    const { cards } = toCards([
      row("27072", { verdict: "MATCH", strength: "CONFIRMED" }),
      row("27073", { verdict: "MATCH", strength: "CONFIRMED" }),
      row("25206"),
    ]);
    expect(cards.map((c) => c.lead.recallNumber).sort()).toEqual(["27072", "27073"]);
    expect(cards.flatMap((c) => c.also.map((r) => r.recallNumber))).toEqual(["25206"]);
  });

  it("keeps a row already acted on in front, so what was sent never drops out of sight", () => {
    const notice = { id: "n", kind: "CHECK_REQUEST", state: "PREPARED" as const, stopped: false, result: null };
    const { cards } = toCards([row("27040", { strength: "BRAND" }), row("25206", { notice })]);
    expect(cards[0].lead.recallNumber).toBe("25206");
  });

  it("orders cards with confirmed matches first and weak ones last", () => {
    const { cards } = toCards([
      row("1", { recordId: "weak" }),
      row("2", { recordId: "brand", strength: "BRAND" }),
      row("3", { recordId: "match", verdict: "MATCH", strength: "CONFIRMED" }),
    ]);
    expect(cards.map((c) => c.lead.recordId)).toEqual(["match", "brand", "weak"]);
  });

  it("lists cleared rows with a reason, and only counts those sharing no word at all", () => {
    const { cleared, unrelated, cards } = toCards([
      row("25150", { verdict: "CLEARED", strength: "NO_SHARED_WORDS" }),
      row("25343", { verdict: "CLEARED", strength: "NO_SHARED_WORDS" }),
      row("27072", { verdict: "CLEARED", strength: "BRAND" }),
    ]);
    expect(cards).toEqual([]);
    expect(unrelated).toBe(2);
    expect(cleared.map((r) => r.recallNumber)).toEqual(["27072"]);
  });
});

describe("tellCpscDraft", () => {
  it("states the recall, product, count and dates, and no buyer data", () => {
    const draft = tellCpscDraft({
      shopName: "DEMO SHOP",
      recallNumber: "27027",
      product: "Papablic Bedside Sleepers with Play Yard Extensions",
      recallUrl: "https://cpsc.gov/x",
      saleDates: ["2026-11-06", "2026-11-07"],
    });
    expect(draft).toContain("CPSC recall 27027");
    expect(draft).toContain("Papablic Bedside Sleepers with Play Yard Extensions");
    expect(draft).toContain("2 sale(s)");
    expect(draft).toContain("2026-11-06, 2026-11-07");
    expect(draft).not.toMatch(/@|buyer email/i);
  });
});
