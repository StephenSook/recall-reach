// The follow-ups an owner has confirmed. Each is a date on their own timeline and queue card. Nothing here sends anything, and
// none of it comes from PayPal: the date is the owner's and the reason is Claude's reading of CPSC's text. If CPSC changes that
// text, the reminder drops out and the sale can be planned again, so old advice never reads as current.
import type { Queryable } from "../db/types";

export interface SavedFollowUp {
  matchId: string;
  due: string;
  reason: string;
  hazardQuote: string;
  movedEarlier: boolean;
  /** The CPSC text the reason and quote came from. */
  snapshot: string;
}

export async function followUpsFor(db: Queryable, shopId: string): Promise<SavedFollowUp[]> {
  const { rows } = await db.query<{ match_id: string; due: string; reason: string; hazard_quote: string; moved_earlier: boolean; recall_sha256: string }>(
    `select f.match_id, f.due_on::text as due, f.reason, f.hazard_quote, f.moved_earlier, f.recall_sha256
     from follow_ups f join recall_matches m on m.id = f.match_id join recalls r on r.recall_id = m.recall_id
     where f.shop_id = $1 and f.recall_sha256 = r.raw_sha256
     order by f.due_on, f.match_id`,
    [shopId],
  );
  return rows.map((r) => ({ matchId: r.match_id, due: r.due, reason: r.reason, hazardQuote: r.hazard_quote, movedEarlier: r.moved_earlier, snapshot: r.recall_sha256 }));
}

/** This shop's sales matched to the CPSC text with this hash. Two records can share a recall number, and advice read from one can't be saved on the other's sales. */
export async function saleIdsOnText(db: Queryable, shopId: string, snapshot: string): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    "select m.id from recall_matches m join recalls r on r.recall_id = m.recall_id where m.shop_id = $1 and r.raw_sha256 = $2",
    [shopId, snapshot],
  );
  return new Set(rows.map((r) => r.id));
}

/** False when the match isn't this shop's, or CPSC has changed the recall since this advice was read: it saves only against the text it came from. */
export async function saveFollowUp(db: Queryable, input: { shopId: string } & SavedFollowUp): Promise<boolean> {
  const { rows } = await db.query(
    `insert into follow_ups (match_id, shop_id, due_on, reason, hazard_quote, moved_earlier, recall_sha256)
     select m.id, m.shop_id, $3::date, $4, $5, $6, $7 from recall_matches m join recalls r on r.recall_id = m.recall_id where m.id = $1 and m.shop_id = $2 and r.raw_sha256 = $7
     on conflict (match_id) do update set due_on = excluded.due_on, reason = excluded.reason, hazard_quote = excluded.hazard_quote, moved_earlier = excluded.moved_earlier, recall_sha256 = excluded.recall_sha256, updated_at = now()
     returning 1`,
    [input.matchId, input.shopId, input.due, input.reason, input.hazardQuote, input.movedEarlier, input.snapshot],
  );
  return rows.length > 0;
}

export async function dropFollowUp(db: Queryable, shopId: string, matchId: string): Promise<boolean> {
  const { rows } = await db.query("delete from follow_ups where match_id = $1 and shop_id = $2 returning 1", [matchId, shopId]);
  return rows.length > 0;
}
