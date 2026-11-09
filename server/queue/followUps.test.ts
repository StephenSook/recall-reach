import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { dropFollowUp, followUpsFor, saleIdsOnText, saveFollowUp } from "./followUps";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");

describe("the follow-ups a shop has confirmed", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopA: string;
  let shopB: string;
  let match: string;
  let sha: string;

  const newMatch = async (shop: string) => {
    const { rows: items } = await db.query<{ id: string }>("insert into shop_items (shop_id, title, source) values ($1, 'A high chair', 'test') returning id", [shop]);
    const { rows: recalls } = await db.query<{ recall_id: number; raw_sha256: string }>("select recall_id, raw_sha256 from recalls limit 1");
    const { rows } = await db.query<{ id: string }>("insert into recall_matches (shop_id, recall_id, recall_sha256, shop_item_id, verdict, matched, missing, reason) values ($1, $2, $3, $4, 'MATCH', '[]'::jsonb, '[]'::jsonb, 'test') returning id", [shop, recalls[0].recall_id, recalls[0].raw_sha256, items[0].id]);
    return rows[0].id;
  };
  const current = async () => (await db.query<{ raw_sha256: string }>("select r.raw_sha256 from recall_matches m join recalls r using (recall_id) where m.id = $1", [match])).rows[0].raw_sha256;
  const input = (over: object = {}) => ({ shopId: shopA, matchId: match, due: "2026-11-12", reason: "Entrapment is serious.", hazardQuote: "entrapment", movedEarlier: false, snapshot: sha, ...over });

  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    shopA = await createShop(db, { name: "A", kind: "DEMO" });
    shopB = await createShop(db, { name: "B", kind: "DEMO" });
    match = await newMatch(shopA);
    sha = await current();
  });
  afterEach(async () => {
    await db.close();
  });

  it("finds this shop's sales matched to the CPSC text a plan read, and no other shop's", async () => {
    await newMatch(shopB);
    expect(await saleIdsOnText(db, shopA, sha)).toEqual(new Set([match]));
  });

  it("leaves out a sale matched to another record of the recall, which that plan's text can't be saved against", async () => {
    expect(await saleIdsOnText(db, shopA, "text-of-another-record")).toEqual(new Set());
  });

  describe("when CPSC edits the recall after this sale was matched, and the sale hasn't been checked against the new text", () => {
    const newText = "the-recalls-new-text";
    const edited = async () => {
      await db.query("update recalls set raw_sha256 = $1 where recall_id = (select recall_id from recall_matches where id = $2)", [newText, match]);
    };

    it("doesn't plan on the new text", async () => {
      await edited();
      expect(await saleIdsOnText(db, shopA, newText)).toEqual(new Set());
    });

    it("doesn't save advice read from the new text", async () => {
      await edited();
      expect(await saveFollowUp(db, input({ snapshot: newText }))).toBe(false);
    });
  });

  it("keeps what was confirmed", async () => {
    expect(await saveFollowUp(db, input())).toBe(true);
    expect(await followUpsFor(db, shopA)).toEqual([{ matchId: match, due: "2026-11-12", reason: "Entrapment is serious.", hazardQuote: "entrapment", movedEarlier: false, snapshot: sha }]);
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

  it("can be planned again once the sale has been checked against the new text, and shows", async () => {
    await saveFollowUp(db, input());
    await db.query("update recalls set raw_sha256 = 'a-new-snapshot' where recall_id = (select recall_id from recall_matches where id = $1)", [match]);
    await db.query("update recall_matches set recall_sha256 = 'a-new-snapshot' where id = $1", [match]);
    await saveFollowUp(db, input({ due: "2026-11-20", snapshot: "a-new-snapshot" }));
    expect(await followUpsFor(db, shopA)).toMatchObject([{ due: "2026-11-20" }]);
  });

  it("won't save advice read from older CPSC text, even if CPSC changed a moment ago", async () => {
    await db.query("update recalls set raw_sha256 = 'a-new-snapshot' where recall_id = (select recall_id from recall_matches where id = $1)", [match]);
    expect(await saveFollowUp(db, input())).toBe(false);
    expect(await followUpsFor(db, shopA)).toEqual([]);
  });

  it("only returns this shop's", async () => {
    const theirs = await newMatch(shopB);
    await saveFollowUp(db, input());
    await saveFollowUp(db, input({ shopId: shopB, matchId: theirs }));
    expect((await followUpsFor(db, shopA)).map((f) => f.matchId)).toEqual([match]);
  });
});
