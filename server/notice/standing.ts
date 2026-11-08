// A shop's choice, for one recall, to have notices prepared for the sales the check reads as a match, without approving each
// one. Nothing sends by itself: each still opens in the shop's own mail and the owner sends it. A sale the check can't tell
// about still asks the owner, and refunds aren't touched.
import type { Queryable } from "../db/types";
import { NoticeRefused, prepareNotice } from "./store";

export type StandingRefusal = "TYPED_WRONG" | "NOTHING_TO_PREPARE";

export class StandingRefused extends Error {
  constructor(
    readonly code: StandingRefusal,
    message: string,
  ) {
    super(message);
    this.name = "StandingRefused";
  }
}

const MATCHES = `select m.id from recall_matches m join order_lines l on l.id = m.order_line_id
  where m.shop_id = $1 and m.recall_id = $2 and m.verdict = 'MATCH' and not l.capture_pending`;

/** Prepares what isn't prepared yet. One that can't be, such as two orders that could be one, stays on the owner's card. */
async function prepareFor(db: Queryable, shopId: string, recallId: number): Promise<void> {
  const { rows } = await db.query<{ id: string }>(`${MATCHES} and not exists (select 1 from notices n where n.match_id = m.id)`, [shopId, recallId]);
  for (const { id } of rows) {
    try {
      await prepareNotice(db, { shopId, matchId: id, onlyIfMatch: true });
    } catch (err) {
      if (!(err instanceof NoticeRefused)) throw err;
    }
  }
}

export async function turnOnStanding(db: Queryable, input: { shopId: string; recallNumber: string; typed: string }): Promise<void> {
  if (input.typed.trim() !== input.recallNumber) throw new StandingRefused("TYPED_WRONG", `Type ${input.recallNumber} to turn this on.`);
  const { rows } = await db.query<{ recall_id: number }>("select recall_id from recalls where recall_number = $1 order by recall_date desc limit 1", [input.recallNumber]);
  const recallId = rows[0]?.recall_id;
  const matches = recallId === undefined ? [] : (await db.query(MATCHES, [input.shopId, recallId])).rows;
  if (recallId === undefined || matches.length === 0) throw new StandingRefused("NOTHING_TO_PREPARE", "No sale here is read as a match for this recall.");
  await db.query("insert into standing_notices (shop_id, recall_id) values ($1, $2) on conflict do nothing", [input.shopId, recallId]);
  await prepareFor(db, input.shopId, recallId);
}

export async function turnOffStanding(db: Queryable, input: { shopId: string; recallNumber: string }): Promise<void> {
  await db.query("delete from standing_notices where shop_id = $1 and recall_id in (select recall_id from recalls where recall_number = $2)", [input.shopId, input.recallNumber]);
}

/** When a new sale reaches a shop: anything that now matches a recall this shop turned this on for. Called from there, and not from the check itself, which stays rules only. */
export async function prepareStandingNotices(db: Queryable, shopId: string): Promise<void> {
  const { rows } = await db.query<{ recall_id: number }>("select recall_id from standing_notices where shop_id = $1", [shopId]);
  for (const { recall_id } of rows) await prepareFor(db, shopId, recall_id);
}

export async function standingRecalls(db: Queryable, shopId: string): Promise<string[]> {
  const { rows } = await db.query<{ recall_number: string }>("select r.recall_number from standing_notices s join recalls r using (recall_id) where s.shop_id = $1 order by r.recall_number", [shopId]);
  return rows.map((r) => r.recall_number);
}
