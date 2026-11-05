import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { seedDemoShop } from "../demo/seed";
import { createShop } from "../import/store";
import { markOpened, prepareNotice, recordFamilyStopped } from "../notice/store";
import type { Method, PayPalClient, RequestOptions } from "../paypal/client";
import { approveRefund } from "../paypal/refunds";
import { loadQueue, tellCpscDraft } from "./queue";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";

function fakePayPal(): PayPalClient {
  const orders = new Map<string, unknown>();
  return {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      if (method === "POST") {
        const id = `RAWORDERID${orders.size}`;
        const unit = (opts.body as { purchase_units: { amount: unknown }[] }).purchase_units[0];
        orders.set(id, {
          id,
          status: "COMPLETED",
          purchase_units: [{ ...unit, payments: { captures: [{ id: `RAWCAPTUREID${orders.size}`, status: "COMPLETED", create_time: `${TODAY}T14:00:00Z`, amount: unit.amount }] } }],
        });
        return { status: 201, data: { id } };
      }
      return { status: 200, data: orders.get(path.split("/").pop() ?? "") };
    }) as PayPalClient["request"],
  };
}

describe("loadQueue", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    ({ shopId } = await seedDemoShop(db, fakePayPal(), { today: TODAY, secret: "k".repeat(32) }));
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

  it("orders what needs a person first: matches, then gaps, then cleared", async () => {
    const q = await loadQueue(db, shopId, "session-1");
    const order = q.rows.map((r) => r.verdict);
    expect(order).toEqual([...order].sort((a, b) => ["MATCH", "SCOPE_GAP", "CLEARED"].indexOf(a) - ["MATCH", "SCOPE_GAP", "CLEARED"].indexOf(b)));
  });

  it("carries the run's coverage", async () => {
    const q = await loadQueue(db, shopId, "session-1");
    expect(q.coverage).toMatchObject({ recallsChecked: 55, searchedTo: TODAY, unidentifiedPayments: 0, paypalSearched: true, candidatesNotChecked: 0 });
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
    const a = await approveRefund(db, { shopId, sessionId: "session-1", matchId });
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
