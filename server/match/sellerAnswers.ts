// A seller's answer to "is this the recalled product?". It tests the matcher and changes no card: a seller saying "no"
// must never hide a recall, and a seller saying "yes" proves nothing about a unit nobody has checked.
import type { Recall } from "../cpsc/schema";
import type { Queryable } from "../db/types";
import { verdictFor } from "./verdict";

export type SellerAnswer = "SAME_PRODUCT" | "DIFFERENT_PRODUCT";

const ANSWERS: readonly string[] = ["SAME_PRODUCT", "DIFFERENT_PRODUCT"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COUNTED = 5000;

/** The server reads the recall and the title from the shop's own match, so nothing but the answer comes from the browser. */
export async function recordSellerAnswer(db: Queryable, input: { shopId: string; matchId: string; answer: string }): Promise<boolean> {
  if (!UUID.test(input.matchId) || !ANSWERS.includes(input.answer)) return false;
  const { rows } = await db.query(
    `insert into seller_answers (shop_id, recall_number, listing_title, answer)
     select m.shop_id, r.recall_number, coalesce(l.title, i.title), $3
     from recall_matches m
     join recalls r on r.recall_id = m.recall_id
     left join order_lines l on l.id = m.order_line_id
     left join shop_items i on i.id = m.shop_item_id
     where m.id = $1 and m.shop_id = $2 and coalesce(l.title, i.title) is not null
     on conflict (shop_id, recall_number, listing_title) do update set answer = excluded.answer
     returning 1`,
    [input.matchId, input.shopId, input.answer],
  );
  return rows.length > 0;
}

export interface SellerTally {
  answers: number;
  sameProduct: number;
  differentProduct: number;
  /** The matcher raises it and the seller said it's the product, or clears it and the seller said it isn't. */
  matcherAgrees: number;
  /** The seller said it's a different product, and the matcher still raises it. */
  stillRaised: number;
  /** The seller said it's the recalled product, and the matcher now clears it. */
  nowCleared: number;
}

/** Real shops only, and counts only: never a shop, a title or a recall. Each answer is re-run through today's matcher. */
export async function sellerTally(db: Queryable): Promise<SellerTally> {
  const { rows } = await db.query<{ listing_title: string; answer: SellerAnswer } & Pick<Recall, "title" | "description" | "products" | "retailers">>(
    `select a.listing_title, a.answer, r.title, r.description, r.products, r.retailers
     from seller_answers a
     join shops s on s.id = a.shop_id and s.kind = 'REAL'
     join lateral (select title, description, products, retailers from recalls x where x.recall_number = a.recall_number order by x.recall_date desc limit 1) r on true
     limit $1`,
    [MAX_COUNTED],
  );
  const tally: SellerTally = { answers: 0, sameProduct: 0, differentProduct: 0, matcherAgrees: 0, stillRaised: 0, nowCleared: 0 };
  for (const row of rows) {
    const raised = verdictFor(row, { title: row.listing_title }).verdict !== "CLEARED";
    tally.answers++;
    if (row.answer === "SAME_PRODUCT") {
      tally.sameProduct++;
      if (raised) tally.matcherAgrees++;
      else tally.nowCleared++;
    } else {
      tally.differentProduct++;
      if (raised) tally.stillRaised++;
      else tally.matcherAgrees++;
    }
  }
  return tally;
}
