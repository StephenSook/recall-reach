// The follow-ups an owner has confirmed. Each is a date on their own timeline and queue card. Nothing here sends anything, and
// none of it comes from PayPal: the date is the owner's and the reason is Claude's reading of CPSC's text. If CPSC changes that
// text, the reminder drops out, and the sale can be planned again only once it's been checked against the new text.
import type { Db, Queryable } from "../db/types";

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

/** This shop's sales matched against the CPSC text with this hash. Two records can share a recall number, and CPSC can edit one after a sale was matched: advice read from other text can't be saved on those sales. */
export async function saleIdsOnText(db: Queryable, shopId: string, snapshot: string): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    "select m.id from recall_matches m join recalls r on r.recall_id = m.recall_id where m.shop_id = $1 and r.raw_sha256 = $2 and m.recall_sha256 = $2",
    [shopId, snapshot],
  );
  return new Set(rows.map((r) => r.id));
}

/** A cancelled save can only be a moment old, so a day is ample. */
const CANCELS_KEPT = "1 day";

/**
 * Every change to a sale's reminder, a save or a dismissal, carries its own id. The page sends the ids of its earlier changes
 * that got no clear answer, and those are cancelled here, so whichever lands late can't undo what the owner did after it.
 * The sale's row is locked first, so two changes arriving together take turns and the second sees the first. And a change
 * the server received before one that has already landed is refused, so the owner's order holds after a reload too.
 * False when the sale isn't this shop's; "cancelled" when a later change already cancelled this one.
 */
/** This change's place in line, taken as the server receives it. A database sequence, so no two changes share one. */
export async function nextArrival(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ n: string }>("select nextval('follow_up_arrivals')::text as n");
  return rows[0].n;
}

async function claimTurn(tx: Queryable, shopId: string, matchId: string, attempt: string, supersedes: readonly string[], arrival: string | undefined): Promise<true | false | "cancelled"> {
  const { rows: mine } = await tx.query("select 1 from recall_matches where id = $1 and shop_id = $2 for update", [matchId, shopId]);
  if (mine.length === 0) return false;
  for (const earlier of supersedes) await tx.query("insert into follow_up_cancels (attempt, shop_id) values ($1, $2) on conflict do nothing", [earlier, shopId]);
  const { rows: cancelled } = await tx.query("select 1 from follow_up_cancels where attempt = $1 and shop_id = $2", [attempt, shopId]);
  if (cancelled.length > 0) return "cancelled";
  const place = arrival ?? (await nextArrival(tx));
  // A change the server received after this one has already landed: this one is out of date.
  const { rows: newer } = await tx.query("select 1 from follow_up_fences where match_id = $1 and arrival > $2::bigint", [matchId, place]);
  if (newer.length > 0) return "cancelled";
  await tx.query(
    `insert into follow_up_fences (match_id, shop_id, arrival) values ($1, $2, $3::bigint)
     on conflict (match_id) do update set arrival = excluded.arrival`,
    [matchId, shopId, place],
  );
  return true;
}

/** False when the match isn't this shop's, or CPSC has changed the recall since this advice was read: it saves only against the text it came from. */
export async function saveFollowUp(db: Db, input: { shopId: string; attempt: string; supersedes?: readonly string[]; arrival?: string } & SavedFollowUp): Promise<boolean | "cancelled"> {
  return db.transaction(async (tx) => {
    const ready = await claimTurn(tx, input.shopId, input.matchId, input.attempt, input.supersedes ?? [], input.arrival);
    if (ready !== true) return ready;
    const { rows } = await tx.query(
      `insert into follow_ups (match_id, shop_id, due_on, reason, hazard_quote, moved_earlier, recall_sha256)
       select m.id, m.shop_id, $3::date, $4, $5, $6, $7 from recall_matches m join recalls r on r.recall_id = m.recall_id where m.id = $1 and m.shop_id = $2 and r.raw_sha256 = $7 and m.recall_sha256 = $7
       on conflict (match_id) do update set due_on = excluded.due_on, reason = excluded.reason, hazard_quote = excluded.hazard_quote, moved_earlier = excluded.moved_earlier, recall_sha256 = excluded.recall_sha256, updated_at = now()
       returning 1`,
      [input.matchId, input.shopId, input.due, input.reason, input.hazardQuote, input.movedEarlier, input.snapshot],
    );
    return rows.length > 0;
  });
}

/** Removes the reminder. Like a save, it carries its own id and cancels the earlier changes the page never heard back from. */
export async function dropFollowUp(db: Db, shopId: string, matchId: string, change: { attempt: string; supersedes?: readonly string[]; arrival?: string }): Promise<boolean | "cancelled"> {
  return db.transaction(async (tx) => {
    const ready = await claimTurn(tx, shopId, matchId, change.attempt, change.supersedes ?? [], change.arrival);
    if (ready !== true) return ready;
    await tx.query(`delete from follow_up_cancels where created_at < now() - interval '${CANCELS_KEPT}'`);
    const { rows } = await tx.query("delete from follow_ups where match_id = $1 and shop_id = $2 returning 1", [matchId, shopId]);
    return rows.length > 0;
  });
}
