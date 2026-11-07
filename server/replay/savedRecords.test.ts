import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { seedDemoShop } from "../demo/seed";
import type { Method, PayPalClient, RequestOptions } from "../paypal/client";
import { verdictFor } from "../match/verdict";
import { PAST_WINDOW_SAMPLE } from "../paypal/payouts";
import { loadQueue, toCards } from "../queue/queue";
import { loadReplay, runReplay } from "./replay";

/** CPSC's 1,855 recalls as read on 2026-11-05: public text. With these fixed, only a change to this code can move a number. */
const saved = gunzipSync(readFileSync(new URL("../../test/fixtures/cpsc/saved_records_2022_to_2026-11-05.json.gz", import.meta.url))).toString();
const TODAY = "2026-11-06";
const NOW = new Date(`${TODAY}T15:00:00Z`);
const SECRET = "k".repeat(32);

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

describe("the published numbers, on CPSC's saved records", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  const client = fakePayPal();

  beforeAll(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(saved, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2022-01-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    ({ shopId } = await seedDemoShop(db, client, { today: TODAY, secret: SECRET, now: NOW }));
  }, 300_000);
  afterAll(async () => {
    await db.close();
  });

  it("the demo queue's counts", async () => {
    const q = await loadQueue(db, shopId, "session");
    const { cards, cleared, unrelated } = toCards(q.rows);
    const verdicts = (v: string) => q.rows.filter((r) => r.verdict === v).length;
    expect({ candidates: q.rows.length, cards: cards.length, cleared: cleared.length, unrelated, match: verdicts("MATCH"), gap: verdicts("SCOPE_GAP"), checked: q.coverage?.recallsChecked }).toEqual({
      candidates: 58,
      cards: 9,
      cleared: 9,
      unrelated: 15,
      match: 4,
      gap: 30,
      checked: 1855,
    });
    expect(cards.map((c) => `${c.lead.recallNumber} ${c.lead.verdict} ${c.lead.strength}`).sort()).toEqual([
      "22200 SCOPE_GAP BRAND",
      "26688 SCOPE_GAP BRAND",
      "26688 SCOPE_GAP BRAND",
      "26724 SCOPE_GAP BRAND",
      "27018 MATCH CONFIRMED",
      "27027 MATCH CONFIRMED",
      "27027 MATCH CONFIRMED",
      "27040 SCOPE_GAP BRAND",
      "27072 MATCH CONFIRMED",
    ]);
  }, 300_000);

  it("the past-window sample is what it says: a real recall, a confirmed title, sold after the recall and past 180 days", async () => {
    const { rows } = await db.query<{ recall_date: string; title: string; description: string; products: { name: string; model: string; type: string | null; units: string | null }[]; retailers: string[] }>(
      "select recall_date::text as recall_date, title, description, products, retailers from recalls where recall_number = $1",
      [PAST_WINDOW_SAMPLE.recallNumber],
    );
    expect(rows).toHaveLength(1);
    expect(verdictFor(rows[0], { title: PAST_WINDOW_SAMPLE.title, orderedOn: PAST_WINDOW_SAMPLE.soldOn })).toMatchObject({ verdict: "MATCH", strength: "CONFIRMED" });
    expect(PAST_WINDOW_SAMPLE.soldOn > rows[0].recall_date).toBe(true);
    expect(Date.parse(TODAY) - Date.parse(PAST_WINDOW_SAMPLE.soldOn)).toBeGreaterThan(180 * 86_400_000);
  });

  it("Replay's split", async () => {
    const { runId } = await runReplay(db, client, { today: TODAY, now: NOW, secret: SECRET });
    const replay = await loadReplay(db, runId);
    expect(replay?.counts).toMatchObject({ checked: 934, matched: 3, scopeGaps: 18, cleared: 11, notNear: 902, noticeOnly: 1, refundEligible: 1, unidentified: 1 });
  }, 300_000);
});
