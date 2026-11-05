// Checks one shop's records against the stored recalls and saves a decision per candidate.
// Local tier only: no third party sees anything here. See server/match/verdict.ts for the rules.
import type { Recall, RecallProduct } from "../cpsc/schema";
import type { Db } from "../db/types";
import { joinOrderLines, type JoinPayment } from "./join";
import { modelTokens, salePath, verdictFor, type SalePath, type Verdict } from "./verdict";

/** Candidates kept per recall (brief: top 20). */
const TOP_CANDIDATES = 20;
/** word_similarity of a shop title to the recall's title and product names. Low, because a miss here is silent. */
const MIN_SIMILARITY = 0.3;

export interface RunSummary {
  runId: string;
  recallsChecked: number;
  matches: number;
  scopeGaps: number;
  cleared: number;
  searchedFrom: string | null;
  searchedTo: string;
  unidentifiedPayments: number;
}

interface Candidate {
  recall_id: number;
  kind: "order_line" | "shop_item";
  id: string;
  title: string;
  description: string;
  ordered_on: string | null;
}

// Two ways in, and either is enough: the title resembles the recall's title and product names
// (trigrams, which catch spelling and spacing), or the shop's text carries a model number that
// appears anywhere in the recall's title or description. $4 maps each item to its model numbers.
const CANDIDATES_SQL = `
  with items as (
    select 'order_line' as kind, id, title, '' as description, ordered_on::text as ordered_on
    from order_lines where shop_id = $1
    union all
    select 'shop_item', id, title, description, null
    from shop_items where shop_id = $1 -- sold-out listings too; the queue shows which are still for sale
  ),
  recall_text as (
    select recall_id,
      lower(title || ' ' || coalesce((select string_agg(p->>'name', ' ') from jsonb_array_elements(products) p), '')) as name_text,
      upper(title || ' ' || description) as doc
    from recalls
  ),
  scored as (
    select r.recall_id, i.kind, i.id, i.title, i.description, i.ordered_on,
      word_similarity(lower(i.title), r.name_text) as similarity,
      exists (
        select 1 from jsonb_array_elements_text(coalesce($4::jsonb -> i.id::text, '[]'::jsonb)) as t(token)
        where position(t.token in r.doc) > 0
      ) as model_hit
    from recall_text r cross join items i
  ),
  ranked as (
    select *, row_number() over (
      partition by recall_id order by model_hit desc, similarity desc, id
    ) as rank
    from scored where model_hit or similarity >= $2
  )
  select recall_id, kind, id, title, description, ordered_on from ranked where rank <= $3`;

export async function runShopCheck(db: Db, shopId: string, opts: { today: string; dateFilter?: boolean }): Promise<RunSummary> {
  const { rows: counted } = await db.query<{ n: string }>("select count(*)::text as n from recalls");
  const { rows: shopText } = await db.query<{ id: string; text: string }>(
    `select id, title as text from order_lines where shop_id = $1
     union all select id, title || ' ' || description from shop_items where shop_id = $1`,
    [shopId],
  );
  const tokens = Object.fromEntries(shopText.map((r) => [r.id, modelTokens(r.text.toUpperCase())]));
  const { rows: candidates } = await db.query<Candidate>(CANDIDATES_SQL, [
    shopId,
    MIN_SIMILARITY,
    TOP_CANDIDATES,
    JSON.stringify(tokens),
  ]);

  const { rows: lines } = await db.query<{ id: string; order_number: string; title: string; sku: string | null; ordered_on: string }>(
    "select id, order_number, title, sku, ordered_on from order_lines where shop_id = $1",
    [shopId],
  );
  const { rows: paymentRows } = await db.query<{ id: string; order_number: string | null; items: JoinPayment["items"]; paid_on: string | null }>(
    "select id, order_number, items, (captured_at at time zone 'UTC')::date::text as paid_on from paypal_payments where shop_id = $1",
    [shopId],
  );
  const joined = joinOrderLines(
    lines.map((l) => ({ id: l.id, orderNumber: l.order_number, title: l.title, sku: l.sku, orderedOn: l.ordered_on })),
    paymentRows.map((p) => ({ key: p.id, orderNumber: p.order_number, items: p.items, paidOn: p.paid_on })),
    { today: opts.today },
  );

  const recallIds = [...new Set(candidates.map((c) => c.recall_id))];
  const { rows: recallRows } = await db.query<{
    recall_id: number;
    title: string;
    description: string;
    products: RecallProduct[];
    retailers: string[];
    recall_date: string;
    raw_sha256: string;
  }>(
    `select recall_id, title, description, products, retailers, recall_date, raw_sha256
     from recalls where recall_id = any($1::int[])`,
    [recallIds],
  );
  const recalls = new Map(recallRows.map((r) => [r.recall_id, r]));

  const counts: Record<Verdict, number> = { MATCH: 0, SCOPE_GAP: 0, CLEARED: 0 };
  return db.transaction(async (tx) => {
    for (const c of candidates) {
      const recall = recalls.get(c.recall_id);
      if (!recall) continue;
      const facts: Pick<Recall, "title" | "description" | "products" | "retailers"> = recall;
      const v = verdictFor(
        facts,
        { title: c.title, description: c.description, orderedOn: c.ordered_on ?? undefined },
        { dateFilter: opts.dateFilter },
      );
      counts[v.verdict]++;
      const path: SalePath | null = c.ordered_on ? salePath(c.ordered_on, recall.recall_date) : null;
      const join = c.kind === "order_line" ? joined.lines[c.id]?.state ?? null : null;
      await tx.query(
        `insert into recall_matches (shop_id, recall_id, recall_sha256, order_line_id, shop_item_id, verdict, matched, missing, reason, sale_path, join_state)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
         on conflict (shop_id, recall_id, coalesce(order_line_id, shop_item_id)) do update set
           recall_sha256 = excluded.recall_sha256, verdict = excluded.verdict, matched = excluded.matched,
           missing = excluded.missing, reason = excluded.reason, sale_path = excluded.sale_path,
           join_state = excluded.join_state, checked_at = now()`,
        [
          shopId,
          c.recall_id,
          recall.raw_sha256,
          c.kind === "order_line" ? c.id : null,
          c.kind === "shop_item" ? c.id : null,
          v.verdict,
          JSON.stringify(v.matched),
          JSON.stringify(v.missing),
          v.reason,
          path,
          join,
        ],
      );
    }
    const dates = lines.map((l) => l.ordered_on).sort();
    const searchedFrom = dates[0] ?? null;
    const { rows } = await tx.query<{ id: string }>(
      `insert into shop_runs (shop_id, recalls_checked, matches, scope_gaps, cleared, searched_from, searched_to, unidentified_payments)
       values ($1, $2, $3, $4, $5, $6::date, $7::date, $8) returning id`,
      [shopId, Number(counted[0].n), counts.MATCH, counts.SCOPE_GAP, counts.CLEARED, searchedFrom, opts.today, joined.unidentifiedPayments],
    );
    return {
      runId: rows[0].id,
      recallsChecked: Number(counted[0].n),
      matches: counts.MATCH,
      scopeGaps: counts.SCOPE_GAP,
      cleared: counts.CLEARED,
      searchedFrom,
      searchedTo: opts.today,
      unidentifiedPayments: joined.unidentifiedPayments,
    };
  });
}
