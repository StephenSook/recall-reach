// Checks stored shops against recalls that arrived after their last check, so a shop hears about a recall
// without uploading again. It shows in the queue on the shop's next visit, and buzzes the shop's phone if it asked.
// Rules only: no Claude, and no message goes to a family. The one PayPal call: when a new recall matches a sale at a
// shop connected to its own PayPal account, that shop's sales are read again, so the sale can join its payment.
import { DEMO_SHOP_HOURS } from "../import/ownFile";
import type { Db } from "../db/types";
import { withCallLog } from "../paypal/callLog";
import type { PlatformEnv } from "../paypal/platform";
import { readConnectedShopSales } from "../shop/connectedSales";
import { ConnectionBusy, connectedMerchant, withConnectionLock } from "../shop/paypalConnection";
import { pushNewCards } from "../push/push";
import { businessDay } from "../time/businessDay";
import { CHECK_FROM, runShopCheck } from "./run";

/** Past this the rest wait for the next tick, and health says how many are waiting. Real shops go first. */
export const SWEEP_MAX_SHOPS = 25;
/** Under half the poll job's deadline, so a long sweep can't hold the job past it. */
export const SWEEP_BUDGET_MS = 4 * 60_000;

export interface SweepSummary {
  at: string;
  shopsChecked: number;
  shopsFailed: number;
  shopsWaiting: number;
}

/** Only rows this check added: a recall can be looked at twice, and a phone hears about a card once. A failure here isn't the shop's. */
async function buzzAboutNewCards(db: Db, shopId: string, recallIds: number[], before: string[], pushFetch?: typeof fetch): Promise<void> {
  try {
    const added = await db.query<{ id: string }>("select id from recall_matches where shop_id = $1 and recall_id = any($2::int[]) and not (id = any($3::uuid[]))", [shopId, recallIds, before]);
    await pushNewCards(db, shopId, added.rows.map((r) => r.id), pushFetch);
  } catch (err) {
    console.error("push skipped:", err instanceof Error ? err.name : "unknown error");
  }
}

/** The platform app and the shop data key, so a connected shop's sales can be read again. Absent: no PayPal call. */
export interface SweepPayPal {
  platform: PlatformEnv;
  secret: string;
}

/**
 * A sale's PayPal payment is kept only 48 hours, so by the time a new recall names it, the payment is usually gone and
 * the sale can't join. For a shop connected to its own PayPal account, its sales are read from PayPal again, under the
 * shop's own lock, whenever this check put a new match on a sale. A busy shop or a refusal leaves the card as it is.
 */
async function readSalesAgain(db: Db, shopId: string, recallIds: number[], paypal: SweepPayPal, now: Date): Promise<void> {
  try {
    const { rows } = await db.query("select 1 from recall_matches where shop_id = $1 and recall_id = any($2::int[]) and verdict = 'MATCH' and order_line_id is not null limit 1", [shopId, recallIds]);
    if (rows.length === 0) return;
    await withCallLog(db, shopId, () =>
      withConnectionLock(db, shopId, async (tx) => {
        const merchant = await connectedMerchant(tx, { shopId, secret: paypal.secret });
        if (merchant) await readConnectedShopSales(tx, paypal.platform.actingFor(merchant), { shopId, now });
      }),
    );
  } catch (err) {
    console.error("sales read again skipped:", err instanceof ConnectionBusy ? "busy" : err instanceof Error ? err.name : "unknown error");
  }
}

export async function checkStoredShops(db: Db, opts: { now: Date; maxShops?: number; budgetMs?: number; pushFetch?: typeof fetch; paypal?: SweepPayPal | null }): Promise<SweepSummary> {
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
      const recallIds = rows.map((r) => r.recall_id);
      const before = await db.query<{ id: string }>("select id from recall_matches where shop_id = $1 and recall_id = any($2::int[])", [id, recallIds]);
      await runShopCheck(db, id, { today: businessDay(opts.now), onlyRecallIds: recallIds });
      shopsChecked++;
      await buzzAboutNewCards(db, id, recallIds, before.rows.map((r) => r.id), opts.pushFetch);
      if (opts.paypal) await readSalesAgain(db, id, recallIds, opts.paypal, opts.now);
    } catch (err) {
      // One shop's failure stays with that shop. Its marker has not moved, so it is tried again next time.
      shopsFailed++;
      console.error(`recall check failed for shop ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { at: opts.now.toISOString(), shopsChecked, shopsFailed, shopsWaiting: behind.length - shopsChecked - shopsFailed };
}
