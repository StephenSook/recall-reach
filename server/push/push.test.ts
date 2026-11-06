import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { pushMessage, pushNewCards, registerPushToken } from "./push";

const fixture: Record<string, unknown>[] = JSON.parse(readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8"));
const TOKEN = "ExponentPushToken[abc-123_DEF]";
const MATCH_ID = "00000000-0000-4000-8000-000000000001";

describe("what a push may say", () => {
  it("says the recall number and where to look, and nothing else", () => {
    expect(pushMessage({ recallNumber: "27018", matchId: MATCH_ID, kind: "sold" }, TOKEN)).toEqual({
      to: TOKEN,
      title: "Recall Reach",
      body: "Recall 27018: something you sold needs a look",
      data: { path: `/queue#sale-${MATCH_ID}` },
      sound: "default",
      priority: "high",
      channelId: "cards",
    });
    expect(pushMessage({ recallNumber: "27018", matchId: MATCH_ID, kind: "listed" }, TOKEN)?.body).toBe("Recall 27018: something you listed needs a look");
  });

  it("can't carry anything else, whatever it's handed", () => {
    const handed = { recallNumber: "27018", matchId: MATCH_ID, kind: "sold", title: "SENTINEL title", buyerEmail: "sentinel@example.test", captureId: "SENTINEL", amountCents: 8888 };
    const wire = JSON.stringify(pushMessage(handed as Parameters<typeof pushMessage>[0], TOKEN));
    expect(wire).not.toMatch(/SENTINEL|sentinel|8888/);
  });

  it.each([
    [{ recallNumber: "27018 and a buyer's name", matchId: MATCH_ID, kind: "sold" }],
    [{ recallNumber: "", matchId: MATCH_ID, kind: "sold" }],
    [{ recallNumber: "27018", matchId: "not-a-match", kind: "sold" }],
    [{ recallNumber: "27018", matchId: "CAPTURE123", kind: "sold" }],
  ] as const)("sends nothing for %j", (card) => {
    expect(pushMessage(card, TOKEN)).toBeNull();
  });
});

describe("a phone's token", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "Shop", kind: "REAL" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });
  const tokens = async (id = shopId) => (await db.query<{ token: string }>("select token from push_tokens where shop_id = $1 order by created_at, token", [id])).rows.map((r) => r.token);

  it("is kept once, however often the page hands it over", async () => {
    expect(await registerPushToken(db, shopId, TOKEN)).toBe(true);
    expect(await registerPushToken(db, shopId, TOKEN)).toBe(true);
    expect(await tokens()).toEqual([TOKEN]);
  });

  it.each(["", "nonsense", "ExponentPushToken[]", "ExponentPushToken[a b]", 'ExponentPushToken[a]"', `ExponentPushToken[${"x".repeat(300)}]`])("refuses %j", async (bad) => {
    expect(await registerPushToken(db, shopId, bad)).toBe(false);
    expect(await tokens()).toEqual([]);
  });

  it("refuses a shop that's gone, without an error", async () => {
    await db.query("delete from shops where id = $1", [shopId]);
    expect(await registerPushToken(db, shopId, TOKEN)).toBe(false);
  });

  it("keeps the five newest for a shop", async () => {
    for (let i = 0; i < 7; i++) {
      await registerPushToken(db, shopId, `ExponentPushToken[t${i}]`);
      await db.query("update push_tokens set created_at = now() - make_interval(mins => $1) where token = $2", [10 - i, `ExponentPushToken[t${i}]`]);
    }
    expect(await tokens()).toEqual(["ExponentPushToken[t2]", "ExponentPushToken[t3]", "ExponentPushToken[t4]", "ExponentPushToken[t5]", "ExponentPushToken[t6]"]);
  });

  it("goes when the shop goes", async () => {
    await registerPushToken(db, shopId, TOKEN);
    await db.query("delete from shops where id = $1", [shopId]);
    expect((await db.query("select 1 from push_tokens")).rows).toEqual([]);
  });

  describe("sending", () => {
    const recallNumber = "27018";
    let recallId: number;
    let matchId: string;
    beforeEach(async () => {
      const record = fixture.filter((r) => r.RecallNumber === recallNumber);
      await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: (async () => new Response(JSON.stringify(record), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch });
      const recall = await db.query<{ recall_id: number; raw_sha256: string }>("select recall_id, raw_sha256 from recalls where recall_number = $1", [recallNumber]);
      recallId = recall.rows[0].recall_id;
      await db.query("insert into shop_items (id, shop_id, title, source) values ('00000000-0000-4000-8000-0000000000aa', $1, 'SENTINEL title', 'x')", [shopId]);
      const { rows } = await db.query<{ id: string }>(
        `insert into recall_matches (shop_id, recall_id, recall_sha256, shop_item_id, verdict, matched, missing, reason, strength)
         values ($1, $2, $3, '00000000-0000-4000-8000-0000000000aa', 'SCOPE_GAP', '[]', '[]', 'SENTINEL reason', 'BRAND') returning id`,
        [shopId, recallId, recall.rows[0].raw_sha256],
      );
      matchId = rows[0].id;
    });
    const expo = (answer: () => Promise<Response> | Response = () => new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 })) => vi.fn(async (_url: string, _init: RequestInit) => answer());

    it("posts to Expo's push service, and sends nothing with no phone", async () => {
      const none = expo();
      expect(await pushNewCards(db, shopId, { matchIds: [matchId] }, none as unknown as typeof fetch)).toBe(0);
      expect(none).not.toHaveBeenCalled();

      await registerPushToken(db, shopId, TOKEN);
      const some = expo();
      expect(await pushNewCards(db, shopId, { recallIds: [recallId] }, some as unknown as typeof fetch)).toBe(1);
      expect(some.mock.calls[0][0]).toBe("https://exp.host/--/api/v2/push/send");
      expect(JSON.parse(String(some.mock.calls[0][1].body))).toEqual([expect.objectContaining({ to: TOKEN, body: "Recall 27018: something you listed needs a look", data: { path: `/queue#sale-${matchId}` } })]);
      expect(String(some.mock.calls[0][1].body)).not.toContain("SENTINEL");
    });

    it("stays quiet about a card that only shares a word with a recall", async () => {
      await db.query("update recall_matches set strength = 'PRODUCT_WORDS' where id = $1", [matchId]);
      await registerPushToken(db, shopId, TOKEN);
      const f = expo();
      expect(await pushNewCards(db, shopId, { recallIds: [recallId] }, f as unknown as typeof fetch)).toBe(0);
      expect(f).not.toHaveBeenCalled();
    });

    it("stays quiet about a cleared row", async () => {
      await db.query("update recall_matches set verdict = 'CLEARED' where id = $1", [matchId]);
      await registerPushToken(db, shopId, TOKEN);
      const f = expo();
      expect(await pushNewCards(db, shopId, { matchIds: [matchId] }, f as unknown as typeof fetch)).toBe(0);
    });

    it.each([
      ["a refused connection", () => Promise.reject(new TypeError("fetch failed"))],
      ["a server error", () => new Response("no", { status: 500 })],
      ["an answer that isn't json", () => new Response("<html>", { status: 200 })],
    ])("never throws on %s, and logs no token", async (_name, answer) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await registerPushToken(db, shopId, TOKEN);
      await expect(pushNewCards(db, shopId, { matchIds: [matchId] }, expo(answer as () => Promise<Response>) as unknown as typeof fetch)).resolves.toBe(0);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("abc-123");
    });

    it("forgets a phone Expo says is gone, and keeps one that's fine", async () => {
      const other = "ExponentPushToken[other]";
      await registerPushToken(db, shopId, other);
      await registerPushToken(db, shopId, TOKEN);
      const f = vi.fn(async (_url: string, init: RequestInit) => {
        const sent = JSON.parse(String(init.body)) as { to: string }[];
        return new Response(JSON.stringify({ data: sent.map((m) => (m.to === TOKEN ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" })) }), { status: 200 });
      });
      expect(await pushNewCards(db, shopId, { matchIds: [matchId] }, f as unknown as typeof fetch)).toBe(1);
      expect(await tokens()).toEqual([other]);
    });
  });
});
