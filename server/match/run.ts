// Checks one shop's records against the stored recalls and saves a decision per candidate.
// Local tier only: no third party sees anything here. See server/match/verdict.ts for the rules.
import type { Recall, RecallProduct } from "../cpsc/schema";
import { missingRecallYears } from "../cpsc/load";
import type { Db, Queryable } from "../db/types";
import { joinOrderLines, type JoinPayment, type JoinResult } from "./join";
import { codeForms, modelsShown, modelTokens, salePath, verdictFor, type SalePath, type Verdict } from "./verdict";
import { BUSINESS_TIME_ZONE_SQL, businessDay } from "../time/businessDay";
import type { SearchCoverage } from "../paypal/transactions";

/**
 * How far back a shop is checked. Resale goods are old, so a 2022 recall still describes things on shelves today.
 * Anything older that CPSC republishes is stored but not checked, because those years aren't all here.
 */
export const CHECK_FROM = "2022-01-01";

/** Distinct titles checked per recall. Anything past this is counted on the run, not dropped quietly. */
const TOP_CANDIDATES = 20;
/** word_similarity of a shop title to the recall's title and product names. Low, because a miss here is silent. */
export const MIN_SIMILARITY = 0.3;

export interface RunSummary {
  /** Null when only one record was checked: that says nothing about the shop's coverage. */
  runId: string | null;
  recallsChecked: number;
  /** The dates of the recalls really checked, read from the recalls themselves. Null when there were none. */
  recallsFrom: string | null;
  recallsTo: string | null;
  /** Years inside that range that didn't load, so the range can't hide a gap. */
  recallYearsMissing: number[];
  matches: number;
  scopeGaps: number;
  cleared: number;
  searchedFrom: string | null;
  searchedTo: string;
  unidentifiedPayments: number;
  /** Distinct-title candidates past the per-recall cap. Above zero, coverage is incomplete. */
  candidatesNotChecked: number;
}

interface Candidate {
  recall_id: number;
  kind: "order_line" | "shop_item" | "safety_receipt";
  id: string;
  title: string;
  description: string;
  ordered_on: string | null;
  similarity: number;
  model_hit: boolean;
}

/**
 * Items per statement. word_similarity is the cost, about 22 microseconds a pair on the free tier (measured on
 * production), and the pool stops any statement at 60 s. At 1,855 recalls this is about 10 s, so a full-size file can't
 * get near that limit, however many recalls come.
 */
export const ITEMS_PER_STATEMENT = 250;

// Two ways in, and either is enough: the title resembles the recall's title and product names
// (trigrams, which catch spelling and spacing), or the shop's text carries a model number that
// appears anywhere in the recall's title or description. $3 maps each item to its model numbers.
const CANDIDATES_SQL = `
  with items as (
    select 'order_line' as kind, id, title, '' as description, ordered_on::text as ordered_on
    from order_lines where shop_id = $1 and not capture_pending and id = any($4::uuid[])
    union all
    select 'shop_item', id, title, description, null
    from shop_items where shop_id = $1 and id = any($4::uuid[]) -- sold-out listings too; the queue shows which are still for sale
    union all
    select 'safety_receipt', id, concat_ws(' ', brand, item, model), '' as description, null
    from safety_receipts where shop_id = $1 and id = any($4::uuid[]) and created_at + interval '3 years' > now()
  ),
  recall_text as materialized (
    select recall_id,
      lower(title || ' ' || coalesce((select string_agg(p->>'name', ' ') from jsonb_array_elements(products) p), '')) as name_text,
      -- Punctuation inside a code goes, so QX-7702 is QX7702. A space stays, or the end of one sentence joins the next word.
      regexp_replace(upper(title || ' ' || description), '(?<=[A-Z0-9])[^A-Z0-9[:space:]]+(?=[A-Z0-9])', '', 'g') as doc
    from recalls
    where recall_date >= $6::date and ($5::int[] is null or recall_id = any($5::int[]))
  ),
  scored as (
    select r.recall_id, i.kind, i.id, i.title, i.description, i.ordered_on,
      word_similarity(lower(i.title), r.name_text) as similarity,
      exists (
        select 1 from jsonb_array_elements_text(coalesce($3::jsonb -> i.id::text, '[]'::jsonb)) as t(token)
        where position(t.token in r.doc) > 0
      ) as model_hit
    from recall_text r cross join items i
  )
  select s.recall_id, s.kind, s.id, s.title, s.description, s.ordered_on, s.similarity, s.model_hit
  from scored s where s.model_hit or s.similarity >= $2`;

/**
 * Per recall, the top distinct titles: one naming a recalled model first, read the way the verdict reads it, then the
 * closest. A part of a model is still looked at on its similarity, so it can't crowd out a real match. It ranks titles, not
 * records: every sale of a popular item is one family to reach. Done here because the candidates arrive in several statements.
 */
async function withinCap(db: Queryable, candidates: Candidate[]): Promise<Candidate[]> {
  const byRecall = new Map<number, Candidate[]>();
  for (const c of candidates) byRecall.set(c.recall_id, [...(byRecall.get(c.recall_id) ?? []), c]);
  // Only a recall with more titles than the cap needs ranking, so only those are read.
  const crowded = [...byRecall].filter(([, group]) => new Set(group.map((c) => c.title.toLowerCase())).size > TOP_CANDIDATES).map(([id]) => id);
  const { rows } = crowded.length > 0 ? await db.query<{ recall_id: number; text: string }>("select recall_id, title || ' ' || description as text from recalls where recall_id = any($1::int[])", [crowded]) : { rows: [] };
  const recallText = new Map(rows.map((r) => [r.recall_id, r.text]));
  const named = new Map<Candidate, boolean>();
  const namesModel = (c: Candidate) => {
    const known = named.get(c);
    if (known !== undefined) return known;
    const text = recallText.get(c.recall_id);
    const answer = text !== undefined && modelsShown(text, `${c.title} ${c.description ?? ""}`).length > 0;
    named.set(c, answer);
    return answer;
  };
  const rankKey = (c: Candidate) => c.title.toLowerCase();
  const kept: Candidate[] = [];
  for (const group of byRecall.values()) {
    const order = [...group].sort(
      (a, b) => Number(namesModel(b)) - Number(namesModel(a)) || b.similarity - a.similarity || (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : 0),
    );
    const top = new Set<string>();
    for (const c of order) {
      if (top.size < TOP_CANDIDATES) top.add(rankKey(c));
      if (top.has(rankKey(c))) kept.push(c);
    }
  }
  return kept;
}

/** One shop's order lines joined to the PayPal payments held right now, with each payment's capture. */
export async function joinShop(
  db: Queryable,
  shopId: string,
  opts: { today: string; failedMonths?: string[] },
): Promise<{ joined: JoinResult; lines: { ordered_on: string }[]; captureIds: Map<string, string | null> }> {
  const { rows: lines } = await db.query<{ id: string; order_number: string; title: string; sku: string | null; ordered_on: string }>(
    "select id, order_number, title, sku, ordered_on from order_lines where shop_id = $1 and not capture_pending",
    [shopId],
  );
  const { rows: payments } = await db.query<{
    id: string;
    order_number: string | null;
    items: JoinPayment["items"];
    paid_on: string | null;
    capture_id: string | null;
  }>(
    `select id, order_number, items, (captured_at at time zone ${BUSINESS_TIME_ZONE_SQL})::date::text as paid_on, capture_id from paypal_payments where shop_id = $1`,
    [shopId],
  );
  const joined = joinOrderLines(
    lines.map((l) => ({ id: l.id, orderNumber: l.order_number, title: l.title, sku: l.sku, orderedOn: l.ordered_on })),
    payments.map((p) => ({ key: p.id, orderNumber: p.order_number, items: p.items, paidOn: p.paid_on })),
    { today: opts.today, failedMonths: opts.failedMonths },
  );
  return { joined, lines, captureIds: new Map(payments.map((p) => [p.id, p.capture_id])) };
}

export async function runShopCheck(
  db: Db,
  shopId: string,
  opts: {
    today: string;
    dateFilter?: boolean;
    /** True only if PayPal was read for this run. Otherwise an absent payment proves nothing. */
    paypalSearched?: boolean;
    /**
     * A connected shop's latest PayPal read stopped partway: payments stored by an earlier read may not be the only ones
     * for a sale, so a new card records no join from them. Cards that already had one keep it until a complete read.
     */
    storedPaymentsUnproven?: boolean;
    /** What PayPal's search really covered, when one ran. */
    search?: SearchCoverage;
    /** Check this one record only. It says nothing about the shop's coverage, so no run is recorded. */
    onlyRecordId?: string;
    /**
     * Check these new recalls only, for a shop that has already had its full check. It only ever adds rows, so a
     * repeat can't touch a card someone acted on, and the shop counts as checked only when this commits.
     */
    onlyRecallIds?: number[];
    /** For a run with its own stated window. Otherwise CHECK_FROM. */
    recallsFrom?: string;
    failedMonths?: string[];
  },
): Promise<RunSummary> {
  const paypalSearched = opts.paypalSearched ?? false;
  const recallsFrom = opts.recallsFrom ?? CHECK_FROM;
  const { rows: counted } = await db.query<{ n: string; first: string | null; last: string | null }>(
    "select count(*)::text as n, min(recall_date)::text as first, max(recall_date)::text as last from recalls where recall_date >= $1::date",
    [recallsFrom],
  );
  const recallYearsMissing = await missingRecallYears(db, Number(recallsFrom.slice(0, 4)), opts.today);
  const { rows: shopText } = await db.query<{ id: string; text: string }>(
    `select id, text from (
       select id, title as text from order_lines where shop_id = $1 and not capture_pending
       union all select id, title || ' ' || description from shop_items where shop_id = $1
       union all select id, concat_ws(' ', brand, item, model) from safety_receipts where shop_id = $1 and created_at + interval '3 years' > now()
     ) records where ($2::uuid is null or id = $2)`,
    [shopId, opts.onlyRecordId ?? null],
  );
  // Compared with the punctuation out of both sides, as the rules and the public check do: MY-002 is MY002.
  const tokens = Object.fromEntries(shopText.map((r) => [r.id, [...new Set(modelTokens(r.text.toUpperCase()).flatMap(codeForms))].filter((t) => t.length >= 3)]));
  const allCandidates: Candidate[] = [];
  for (let at = 0; at < shopText.length; at += ITEMS_PER_STATEMENT) {
    const part = shopText.slice(at, at + ITEMS_PER_STATEMENT);
    const { rows } = await db.query<Candidate>(CANDIDATES_SQL, [
      shopId,
      MIN_SIMILARITY,
      JSON.stringify(Object.fromEntries(part.map((r) => [r.id, tokens[r.id]]))),
      part.map((r) => r.id),
      opts.onlyRecallIds ?? null,
      recallsFrom,
    ]);
    allCandidates.push(...rows);
  }
  const candidates = (await withinCap(db, allCandidates)).filter((c) => !opts.onlyRecordId || c.id === opts.onlyRecordId);
  const candidatesNotChecked = allCandidates.length - candidates.length;

  const { joined, lines } = await joinShop(db, shopId, { today: opts.today, failedMonths: opts.failedMonths });

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
      const computed = c.kind === "order_line" ? joined.lines[c.id]?.state ?? null : null;
      // Unproven stored payments still prove ambiguity: two candidates are two candidates. They just can't prove one.
      const unproven = Boolean(opts.storedPaymentsUnproven) && computed !== null;
      const join = unproven ? (computed === "AMBIGUOUS_JOIN" ? "AMBIGUOUS_JOIN" : "HISTORY_UNAVAILABLE") : computed === "NO_PAYPAL_RECORD" && !paypalSearched ? "HISTORY_UNAVAILABLE" : computed;
      await tx.query(
        `insert into recall_matches (shop_id, recall_id, recall_sha256, order_line_id, shop_item_id, verdict, matched, missing, reason, sale_path, join_state, paypal_payment_id, strength, safety_receipt_id)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $13, $14, $16)
         on conflict (shop_id, recall_id, coalesce(order_line_id, shop_item_id, safety_receipt_id)) do update set
           recall_sha256 = excluded.recall_sha256, verdict = excluded.verdict, matched = excluded.matched,
           missing = excluded.missing, reason = excluded.reason, sale_path = excluded.sale_path, strength = excluded.strength,
           -- Without a fresh PayPal read, keep what an earlier run established: PayPal's data ages out
           -- after 46 hours, and that must not turn an IDENTIFIED or AMBIGUOUS_JOIN into something else.
           join_state = case when $12::boolean then excluded.join_state
                             else coalesce(recall_matches.join_state, excluded.join_state) end,
           paypal_payment_id = case when $12::boolean then excluded.paypal_payment_id
                                    else coalesce(recall_matches.paypal_payment_id, excluded.paypal_payment_id) end,
           checked_at = now()
         where not $15::boolean`,
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
          paypalSearched,
          c.kind === "order_line" && !unproven ? joined.lines[c.id]?.paymentKey ?? null : null,
          v.strength,
          Boolean(opts.onlyRecallIds),
          c.kind === "safety_receipt" ? c.id : null,
        ],
      );
    }
    // The one thing no kind of check leaves as it was: two possible payments are in hand, so outreach waits, on every card
    // for that line, whatever the card said before and whichever recall this check was about.
    await tx.query(
      `update recall_matches set join_state = 'AMBIGUOUS_JOIN', paypal_payment_id = null
       where shop_id = $1 and order_line_id = any($2::uuid[]) and join_state is distinct from 'AMBIGUOUS_JOIN'`,
      [shopId, Object.entries(joined.lines).filter(([, j]) => j.state === "AMBIGUOUS_JOIN").map(([id]) => id)],
    );
    const dates = lines.map((l) => l.ordered_on).sort();
    // PayPal's search runs on UTC. A seller reads dates on the US calendar, like every other date on the page.
    const searchedFrom = opts.search ? businessDay(new Date(opts.search.from)) : (dates[0] ?? null);
    const searchedTo = opts.search ? businessDay(new Date(opts.search.to)) : opts.today;
    if (opts.onlyRecallIds) {
      await tx.query(
        `update shops set recalls_checked_through = greatest(recalls_checked_through, (select max(first_seen_at) from recalls where recall_id = any($2::int[])))
         where id = $1`,
        [shopId, opts.onlyRecallIds],
      );
      // The shop's own record of what it was checked against stays true.
      await tx.query(
        `update shop_runs set candidates_not_checked = candidates_not_checked + $2, recall_years_missing = $4::int[],
           (recalls_checked, recalls_from, recalls_to) = (
             select count(*), min(recall_date), max(recall_date) from recalls
             where recall_date >= $3::date and first_seen_at <= (select recalls_checked_through from shops where id = $1))
         where id = (select id from shop_runs where shop_id = $1 order by finished_at desc limit 1)`,
        [shopId, candidatesNotChecked, recallsFrom, recallYearsMissing],
      );
    }
    const { rows } = opts.onlyRecordId || opts.onlyRecallIds ? { rows: [] } : await tx.query<{ id: string }>(
      `insert into shop_runs (shop_id, recalls_checked, matches, scope_gaps, cleared, searched_from, searched_to, unidentified_payments, candidates_not_checked, paypal_searched, search_windows, failed_windows, rows_read, recalls_from, recalls_to, recall_years_missing)
       values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11, $12, $13, $14::date, $15::date, $16::int[]) returning id`,
      [shopId, Number(counted[0].n), counts.MATCH, counts.SCOPE_GAP, counts.CLEARED, searchedFrom, searchedTo, joined.unidentifiedPayments, candidatesNotChecked, paypalSearched, opts.search?.windows ?? 0, opts.search?.failedWindows.length ?? 0, opts.search?.rowsRead ?? 0, counted[0].first, counted[0].last, recallYearsMissing],
    );
    return {
      runId: rows[0]?.id ?? null,
      recallsChecked: Number(counted[0].n),
      recallsFrom: counted[0].first,
      recallsTo: counted[0].last,
      recallYearsMissing,
      matches: counts.MATCH,
      scopeGaps: counts.SCOPE_GAP,
      cleared: counts.CLEARED,
      searchedFrom,
      searchedTo,
      unidentifiedPayments: joined.unidentifiedPayments,
      candidatesNotChecked,
    };
  });
}
