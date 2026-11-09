// The follow-ups an owner has confirmed. Each is a date on their own timeline and queue card. Nothing here sends anything, and
// none of it comes from PayPal: the date is the owner's and the reason is Claude's reading of CPSC's text.
import type { Queryable } from "../db/types";

export interface SavedFollowUp {
  matchId: string;
  due: string;
  reason: string;
  hazardQuote: string;
  movedEarlier: boolean;
}

export async function followUpsFor(db: Queryable, shopId: string): Promise<SavedFollowUp[]> {
  const { rows } = await db.query<{ match_id: string; due: string; reason: string; hazard_quote: string; moved_earlier: boolean }>("select match_id, due_on::text as due, reason, hazard_quote, moved_earlier from follow_ups where shop_id = $1 order by due_on, match_id", [shopId]);
  return rows.map((r) => ({ matchId: r.match_id, due: r.due, reason: r.reason, hazardQuote: r.hazard_quote, movedEarlier: r.moved_earlier }));
}

/** False when the match isn't this shop's. The insert selects from the shop's own match, so another shop's id reaches nothing. */
export async function saveFollowUp(db: Queryable, input: { shopId: string } & SavedFollowUp): Promise<boolean> {
  const { rows } = await db.query(
    `insert into follow_ups (match_id, shop_id, due_on, reason, hazard_quote, moved_earlier)
     select m.id, m.shop_id, $3::date, $4, $5, $6 from recall_matches m where m.id = $1 and m.shop_id = $2
     on conflict (match_id) do update set due_on = excluded.due_on, reason = excluded.reason, hazard_quote = excluded.hazard_quote, moved_earlier = excluded.moved_earlier, updated_at = now()
     returning 1`,
    [input.matchId, input.shopId, input.due, input.reason, input.hazardQuote, input.movedEarlier],
  );
  return rows.length > 0;
}

export async function dropFollowUp(db: Queryable, shopId: string, matchId: string): Promise<boolean> {
  const { rows } = await db.query("delete from follow_ups where match_id = $1 and shop_id = $2 returning 1", [matchId, shopId]);
  return rows.length > 0;
}
