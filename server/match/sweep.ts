// Checks stored shops against recalls that arrived after their last check, so a shop hears about a recall
// without uploading again. It shows in the queue on the shop's next visit. Rules only: no Claude, no PayPal call,
// and no message goes anywhere.
import type { Db } from "../db/types";
import { businessDay } from "../time/businessDay";
import { CHECK_FROM, runShopCheck } from "./run";

/** Past this the rest wait for the next tick, and health says how many are waiting. Real shops go first. */
export const SWEEP_MAX_SHOPS = 25;
/** Under half the poll job's deadline, so a long sweep can't hold the job past it. */
export const SWEEP_BUDGET_MS = 4 * 60_000;
/** A demo shop is a visit, not a shop's records. After two days its PayPal rows are gone and nobody is looking. */
const DEMO_SHOP_HOURS = 48;

export interface SweepSummary {
  at: string;
  shopsChecked: number;
  shopsFailed: number;
  shopsWaiting: number;
}

export async function checkStoredShops(db: Db, opts: { now: Date; maxShops?: number; budgetMs?: number }): Promise<SweepSummary> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  // Compared inside the database: a marker read into a JS Date loses its microseconds and would never catch up.
  const { rows: behind } = await db.query<{ id: string }>(
    `select s.id from shops s
     where (s.kind = 'REAL' or s.created_at > $1::timestamptz - make_interval(hours => $2))
       and exists (select 1 from recalls r where r.recall_date >= $3::date and r.first_seen_at > s.recalls_checked_through)
     order by (s.kind = 'REAL') desc, s.recalls_checked_through`,
    [opts.now.toISOString(), DEMO_SHOP_HOURS, CHECK_FROM],
  );

  let shopsChecked = 0;
  let shopsFailed = 0;
  for (const { id } of behind.slice(0, opts.maxShops ?? SWEEP_MAX_SHOPS)) {
    if (Date.now() - started > budgetMs) break;
    try {
      const { rows } = await db.query<{ recall_id: number }>(
        "select r.recall_id from recalls r join shops s on r.first_seen_at > s.recalls_checked_through where s.id = $1 and r.recall_date >= $2::date",
        [id, CHECK_FROM],
      );
      await runShopCheck(db, id, { today: businessDay(opts.now), onlyRecallIds: rows.map((r) => r.recall_id) });
      shopsChecked++;
    } catch (err) {
      // One shop's failure stays with that shop. Its marker has not moved, so it is tried again next time.
      shopsFailed++;
      console.error(`recall check failed for shop ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { at: opts.now.toISOString(), shopsChecked, shopsFailed, shopsWaiting: behind.length - shopsChecked - shopsFailed };
}
