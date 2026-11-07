import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { QUESTION_VERSION } from "../agent/questionStore";
import { readItem } from "../agent/sources";
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
      const found = answerSearch(path);
      if (found) return found;
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
    ({ shopId } = await seedDemoShop(db, paypal, { today: TODAY, secret: "k".repeat(32), now: new Date(`${TODAY}T15:00:00Z`) }));
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
    const { rows: records } = await db.query<{ id: string }>("select id from order_lines where shop_id = $1 union all select id from shop_items where shop_id = $1", [shopId]);
    const ids = records.map((l) => l.id);
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

  it("links each demo sale to its payment, from PayPal's history or the capture just made", async () => {
    const q = await loadQueue(db, shopId, "session-1");
    const sales = q.rows.filter((r) => !r.isListing);
    expect(sales.length).toBeGreaterThanOrEqual(3);
    for (const r of sales) expect(r.joinState, r.recallNumber).toBe("IDENTIFIED");
  });

  it("carries the run's coverage", async () => {
    const q = await loadQueue(db, shopId, "session-1");
    expect(q.coverage).toMatchObject({ recallsChecked: 55, searchedTo: TODAY, unidentifiedPayments: 1, paypalSearched: true, candidatesNotChecked: 0 });
    expect(q.shop).toEqual({ name: "DEMO SHOP", kind: "DEMO" });
  });

  it("lists each payment it couldn't tie to an order, with only its date and amount", async () => {
    const q = await loadQueue(db, shopId, "session-1");
    expect(q.unidentified).toHaveLength(1);
    expect(q.unidentified[0]).toEqual({ id: expect.any(String), paidOn: expect.any(String), amountCents: 4200, currency: "USD" });
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

  describe("what the seller sees before approving a question", () => {
    const WRITTEN = "Does your high chair turn into a table and chair set?";
    const write = (question = WRITTEN) =>
      db.query(
        `insert into recall_questions (recall_sha256, agent_version, recall_id, outcome, question, evidence, every_recalled_unit, model, input_tokens, output_tokens, cost_micros)
         select raw_sha256, $1, recall_id, 'QUESTION', $2, 'convert into a table and chair set', true, 'm', 0, 0, 0 from recalls where recall_number = '27040'
         on conflict (recall_sha256, agent_version) do update set question = excluded.question`,
        [QUESTION_VERSION, question],
      );

    it("shows the plain question until Claude has written one", async () => {
      expect((await row("27040")).question).toMatchObject({ question: "Does your high chair convert into a table and chair set?", kind: "yes_no" });
    });

    it("shows the one Claude wrote, with the CPSC words it rests on", async () => {
      await write();
      expect((await row("27040")).question).toMatchObject({ question: WRITTEN, kind: "written", evidence: "convert into a table and chair set" });
    });

    it("has no question for a confirmed match: that gets a safety notice", async () => {
      await write();
      expect((await row("27072")).question).toBeNull();
    });

    it("shows what the family is actually asked once it is approved, whatever is written later", async () => {
      await write();
      const { matchId } = await row("27040");
      await prepareNotice(db, { shopId, matchId });
      await write("Does your high chair have a different question?");
      expect((await row("27040")).question).toMatchObject({ question: WRITTEN });
    });

    it("keeps the plain question on a message approved before Claude wrote one", async () => {
      const { matchId } = await row("27040");
      await prepareNotice(db, { shopId, matchId });
      await write();
      expect((await row("27040")).question).toMatchObject({ kind: "yes_no" });
    });
  });

  describe("how Claude checked it", () => {
    const addRun = async (over: { itemSha?: string; recallSha?: string; outcome?: string; finding?: string | null } = {}) => {
      const { matchId, recordId } = await row("27040");
      const item = await readItem(db, shopId, { kind: "order_line", id: recordId });
      const { rows } = await db.query<{ id: string }>(
        `insert into agent_runs (shop_id, recall_sha256, item_sha256, agent_version, outcome, finding, evidence, missing_field, reason, trace, model, input_tokens, output_tokens, cost_micros)
         select $1, coalesce($2, r.raw_sha256), $3, '1', $4, $5, $6::jsonb, 'Whether it converts', 'The title does not say.', $7::jsonb, 'claude-sonnet-5-5', 1, 1, 1
         from recalls r where r.recall_number = '27040' returning id`,
        [shopId, over.recallSha ?? null, over.itemSha ?? item?.sha256, over.outcome ?? "FINDING", over.finding === undefined ? "CANT_TELL" : over.finding, JSON.stringify([{ source: "recall", quote: "Costway Convertible High Chairs" }]), JSON.stringify([{ tool: "read_recall", ok: true }, { tool: "record_finding", ok: true }])],
      );
      await db.query("update recall_matches set agent_run_id = $1 where id = $2", [rows[0].id, matchId]);
    };

    it("is nothing until it has run", async () => {
      expect((await row("27040")).agent).toBeNull();
    });

    it("shows the finding, the quotes, what is missing and each step", async () => {
      await addRun();
      expect((await row("27040")).agent).toEqual({
        outcome: "FINDING",
        finding: "CANT_TELL",
        evidence: [{ source: "recall", quote: "Costway Convertible High Chairs" }],
        missingField: "Whether it converts",
        reason: "The title does not say.",
        trace: [{ tool: "read_recall", ok: true }, { tool: "record_finding", ok: true }],
        model: "claude-sonnet-5-5",
        checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        fellBack: false,
      });
    });

    it("says when another model answered, not the main one", async () => {
      await addRun();
      await db.query("update agent_runs set model = 'claude-haiku-5-5'");
      expect((await row("27040")).agent).toMatchObject({ model: "claude-haiku-5-5", fellBack: true });
    });

    it("shows that it found nothing, when it did not", async () => {
      await addRun({ outcome: "STEP_LIMIT", finding: null });
      expect((await row("27040")).agent).toMatchObject({ outcome: "STEP_LIMIT", finding: null });
    });

    it("stops showing a finding about text that has since changed", async () => {
      await addRun({ itemSha: "not this text" });
      expect((await row("27040")).agent).toBeNull();
    });

    it("stops showing a finding about an older CPSC record", async () => {
      await addRun({ recallSha: "an older record" });
      expect((await row("27040")).agent).toBeNull();
    });

    it.each(["CANT_TELL", "DIFFERENT_PRODUCT", "SAME_PRODUCT"])("leaves the card's order, verdict and strength alone on %s", async (finding) => {
      const before = await row("27040");
      const cardsBefore = toCards((await loadQueue(db, shopId, "session-1")).rows);
      await addRun({ finding });
      const after = await row("27040");
      expect([after.verdict, after.strength, after.reason]).toEqual([before.verdict, before.strength, before.reason]);
      expect(toCards((await loadQueue(db, shopId, "session-1")).rows).cards.map((c) => c.lead.matchId)).toEqual(cardsBefore.cards.map((c) => c.lead.matchId));
    });
  });

  describe("a sale with a question and then a safety notice", () => {
    const untilConfirmed = async () => {
      const { matchId } = await row("27072");
      await db.query("update recall_matches set verdict = 'SCOPE_GAP', strength = 'BRAND' where id = $1", [matchId]);
      const asked = await prepareNotice(db, { shopId, matchId });
      await markSent(db, { shopId, noticeId: asked.noticeId });
      await db.query("update recall_matches set verdict = 'MATCH', strength = 'CONFIRMED' where id = $1", [matchId]);
      return { matchId, asked };
    };

    it("is one row, showing the question until the seller approves the notice", async () => {
      const { asked } = await untilConfirmed();
      const rows = (await loadQueue(db, shopId, "session-1")).rows.filter((r) => r.recallNumber === "27072" && r.verdict !== "CLEARED"); // the near miss clears
      expect(rows).toHaveLength(1);
      expect(rows[0].notice).toMatchObject({ id: asked.noticeId, kind: "CHECK_REQUEST" });
    });

    it("is still one row after that, showing the notice, and keeps what the family said", async () => {
      const { matchId, asked } = await untilConfirmed();
      await db.query("update notices set check_result = 'MATCHES', responded_at = now() where id = $1", [asked.noticeId]);
      const notice = await prepareNotice(db, { shopId, matchId });
      const rows = (await loadQueue(db, shopId, "session-1")).rows.filter((r) => r.recallNumber === "27072" && r.verdict !== "CLEARED"); // the near miss clears
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
    question: null,
    agent: null, sellerAnswer: null,
    caughtSeconds: null,
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

  it("keeps every sale's card in its place when one is acted on, or when that lapses: a card that moves closes if it is open", () => {
    const order = (rows: QueueRow[]) => toCards(rows).cards.map((c) => c.lead.recallNumber);
    const newer = row("27072", { recordId: "line-1", matchId: "m1" });
    const older = row("27027", { recordId: "line-2", matchId: "m2" });
    const notice = { id: "n", kind: "SAFETY_NOTICE", state: "PREPARED" as const, stopped: false, result: null };
    expect(order([newer, older])).toEqual(["27072", "27027"]);
    expect(order([newer, { ...older, notice }])).toEqual(["27072", "27027"]);
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
