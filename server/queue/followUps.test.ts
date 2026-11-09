import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { dropFollowUp, followUpsFor, saveFollowUp } from "./followUps";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");

describe("the follow-ups a shop has confirmed", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopA: string;
  let shopB: string;
  let match: string;

  const newMatch = async (shop: string) => {
    const { rows: items } = await db.query<{ id: string }>("insert into shop_items (shop_id, title, source) values ($1, 'A high chair', 'test') returning id", [shop]);
    const { rows: recalls } = await db.query<{ recall_id: number; raw_sha256: string }>("select recall_id, raw_sha256 from recalls limit 1");
    const { rows } = await db.query<{ id: string }>("insert into recall_matches (shop_id, recall_id, recall_sha256, shop_item_id, verdict, matched, missing, reason) values ($1, $2, $3, $4, 'MATCH', '[]'::jsonb, '[]'::jsonb, 'test') returning id", [shop, recalls[0].recall_id, recalls[0].raw_sha256, items[0].id]);
    return rows[0].id;
  };
  const input = (over: object = {}) => ({ shopId: shopA, matchId: match, due: "2026-11-12", reason: "Entrapment is serious.", hazardQuote: "entrapment", movedEarlier: false, ...over });

  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    shopA = await createShop(db, { name: "A", kind: "DEMO" });
    shopB = await createShop(db, { name: "B", kind: "DEMO" });
    match = await newMatch(shopA);
  });
  afterEach(async () => {
    await db.close();
  });

  it("keeps what was confirmed", async () => {
    expect(await saveFollowUp(db, input())).toBe(true);
    expect(await followUpsFor(db, shopA)).toEqual([{ matchId: match, due: "2026-11-12", reason: "Entrapment is serious.", hazardQuote: "entrapment", movedEarlier: false }]);
  });

  it("moves the date when it's saved again, and keeps one row", async () => {
    await saveFollowUp(db, input());
    await saveFollowUp(db, input({ due: "2026-11-20", movedEarlier: true }));
    expect(await followUpsFor(db, shopA)).toMatchObject([{ due: "2026-11-20", movedEarlier: true }]);
  });

  it("won't save against another shop's sale", async () => {
    expect(await saveFollowUp(db, input({ shopId: shopB }))).toBe(false);
    expect(await followUpsFor(db, shopB)).toEqual([]);
    expect(await followUpsFor(db, shopA)).toEqual([]);
  });

  it("won't let another shop overwrite one", async () => {
    await saveFollowUp(db, input());
    expect(await saveFollowUp(db, input({ shopId: shopB, due: "2030-01-01" }))).toBe(false);
    expect(await followUpsFor(db, shopA)).toMatchObject([{ due: "2026-11-12" }]);
  });

  it("removes it", async () => {
    await saveFollowUp(db, input());
    expect(await dropFollowUp(db, shopA, match)).toBe(true);
    expect(await followUpsFor(db, shopA)).toEqual([]);
  });

  it("says when there was nothing to remove", async () => {
    expect(await dropFollowUp(db, shopA, match)).toBe(false);
  });

  it("won't let another shop remove one", async () => {
    await saveFollowUp(db, input());
    expect(await dropFollowUp(db, shopB, match)).toBe(false);
    expect(await followUpsFor(db, shopA)).toHaveLength(1);
  });

  it("goes with the sale when its match goes", async () => {
    await saveFollowUp(db, input());
    await db.query("delete from recall_matches where id = $1", [match]);
    expect(await followUpsFor(db, shopA)).toEqual([]);
  });

  it("drops out when CPSC changes the recall, so old advice isn't shown as current", async () => {
    await saveFollowUp(db, input());
    await db.query("update recalls set raw_sha256 = 'a-new-snapshot' where recall_id = (select recall_id from recall_matches where id = $1)", [match]);
    expect(await followUpsFor(db, shopA)).toEqual([]);
  });

  it("can be planned again after that, and shows", async () => {
    await saveFollowUp(db, input());
    await db.query("update recalls set raw_sha256 = 'a-new-snapshot' where recall_id = (select recall_id from recall_matches where id = $1)", [match]);
    await saveFollowUp(db, input({ due: "2026-11-20" }));
    expect(await followUpsFor(db, shopA)).toMatchObject([{ due: "2026-11-20" }]);
  });

  it("only returns this shop's", async () => {
    const theirs = await newMatch(shopB);
    await saveFollowUp(db, input());
    await saveFollowUp(db, input({ shopId: shopB, matchId: theirs }));
    expect((await followUpsFor(db, shopA)).map((f) => f.matchId)).toEqual([match]);
  });
});
