import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { seedDemoShop } from "../demo/seed";
import { createShop } from "../import/store";
import type { Method, PayPalClient, RequestOptions } from "../paypal/client";
import { loadQueue } from "../queue/queue";
import { recordSellerAnswer, sellerTally } from "./sellerAnswers";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const BREZZA = "Baby Brezza SuperFast Sterilizer Dryer BRZ0083";

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

describe("a seller's answer", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    ({ shopId } = await seedDemoShop(db, fakePayPal(), { today: TODAY, secret: "k".repeat(32), now: new Date(`${TODAY}T15:00:00Z`) }));
  });
  afterEach(async () => {
    await db.close();
  });

  const brezza = async () => {
    const q = await loadQueue(db, shopId, "session-1");
    const found = q.rows.find((r) => r.recallNumber === "27072" && r.itemTitle === BREZZA);
    if (!found) throw new Error("no row");
    return found;
  };
  const stored = async () => (await db.query<Record<string, unknown>>("select * from seller_answers")).rows;
  const answer = async (a: string) => recordSellerAnswer(db, { shopId, matchId: (await brezza()).matchId, answer: a });

  it("keeps the recall number, the shop's own title and the answer, and nothing else about the sale", async () => {
    expect(await answer("DIFFERENT_PRODUCT")).toBe(true);
    expect(await stored()).toEqual([{ shop_id: shopId, recall_number: "27072", listing_title: BREZZA, answer: "DIFFERENT_PRODUCT" }]);
  });

  it("comes back on the card", async () => {
    expect((await brezza()).sellerAnswer).toBeNull();
    await answer("SAME_PRODUCT");
    expect((await brezza()).sellerAnswer).toBe("SAME_PRODUCT");
  });

  it("lets a seller change their mind, with one answer per recall and title", async () => {
    await answer("SAME_PRODUCT");
    await answer("DIFFERENT_PRODUCT");
    expect(await stored()).toHaveLength(1);
    expect((await brezza()).sellerAnswer).toBe("DIFFERENT_PRODUCT");
  });

  it("changes nothing else on the card, even when the seller says it's a different product", async () => {
    const { sellerAnswer: before, ...restBefore } = await brezza();
    await answer("DIFFERENT_PRODUCT");
    const { sellerAnswer: after, ...restAfter } = await brezza();
    expect([before, after]).toEqual([null, "DIFFERENT_PRODUCT"]);
    expect(restAfter).toEqual(restBefore);
  });

  it("won't take an answer on another shop's sale", async () => {
    const other = await createShop(db, { name: "Other", kind: "REAL" });
    expect(await recordSellerAnswer(db, { shopId: other, matchId: (await brezza()).matchId, answer: "SAME_PRODUCT" })).toBe(false);
    expect(await stored()).toEqual([]);
  });

  it.each([
    ["an answer it doesn't know", { matchId: "00000000-0000-4000-8000-000000000001", answer: "MAYBE" }],
    ["an id that isn't one", { matchId: "1; drop table shops", answer: "SAME_PRODUCT" }],
    ["a sale that doesn't exist", { matchId: "00000000-0000-4000-8000-000000000001", answer: "SAME_PRODUCT" }],
  ])("refuses %s", async (_name, input) => {
    expect(await recordSellerAnswer(db, { shopId, ...input })).toBe(false);
    expect(await stored()).toEqual([]);
  });

  it("goes when the shop goes", async () => {
    await answer("SAME_PRODUCT");
    await db.query("delete from shops where id = $1", [shopId]);
    expect(await stored()).toEqual([]);
  });

  describe("the count", () => {
    const addReal = async (rows: [string, string, string][]) => {
      const real = await createShop(db, { name: "Real", kind: "REAL" });
      for (const [recall, title, a] of rows) {
        await db.query("insert into seller_answers (shop_id, recall_number, listing_title, answer) values ($1, $2, $3, $4)", [real, recall, title, a]);
      }
      return real;
    };

    it("never counts a demo shop", async () => {
      await answer("SAME_PRODUCT");
      expect(await sellerTally(db)).toEqual({ answers: 0, sameProduct: 0, differentProduct: 0, matcherAgrees: 0, stillRaised: 0, nowCleared: 0 });
    });

    it("re-runs the matcher on each real answer and says where it agrees", async () => {
      await addReal([
        ["27072", BREZZA, "SAME_PRODUCT"], // raised, and the seller agrees
        ["27072", "Hand knitted wool hat", "DIFFERENT_PRODUCT"], // cleared, and the seller agrees
        ["27072", `${BREZZA}, second`, "DIFFERENT_PRODUCT"], // still raised against the seller
        ["27072", "Hand knitted wool scarf", "SAME_PRODUCT"], // cleared against the seller
      ]);
      expect(await sellerTally(db)).toEqual({ answers: 4, sameProduct: 2, differentProduct: 2, matcherAgrees: 2, stillRaised: 1, nowCleared: 1 });
    });

    it("counts only recalls it holds, so every answer in the total was re-run", async () => {
      await addReal([["00000", BREZZA, "SAME_PRODUCT"]]);
      expect((await sellerTally(db)).answers).toBe(0);
    });

    it("goes down when a real shop is deleted", async () => {
      const real = await addReal([["27072", BREZZA, "SAME_PRODUCT"]]);
      expect((await sellerTally(db)).answers).toBe(1);
      await db.query("delete from shops where id = $1", [real]);
      expect((await sellerTally(db)).answers).toBe(0);
    });
  });
});
