// What AG Studio shows on /studio. Its agent's query tool sends rows to the model, so every value here comes from CPSC's
// public records or the demo shop's own item titles, and nothing PayPal returns is read. A test fails if this reads any
// other table, or if a value from a PayPal-sourced table turns up in it.
import type { Queryable } from "../db/types";

export const STUDIO_TABLES = ["replay_runs", "replay_rows", "recalls"] as const;

const OUTCOME = { MATCH: "Matched", SCOPE_GAP: "Can't tell yet", CLEARED: "Cleared", NOT_NEAR: "Nothing near" } as const;

export interface StudioRow {
  recallNumber: string;
  recallTitle: string;
  recallDate: string;
  recallYear: number;
  outcome: (typeof OUTCOME)[keyof typeof OUTCOME];
  /** CPSC's name for the recalled product. */
  product: string;
  /** The demo shop's own title for the item it sold, when one came near. */
  itemTitle: string | null;
}

export async function studioDataset(db: Queryable): Promise<{ runId: string; createdAt: string; rows: StudioRow[] } | null> {
  const run = (await db.query<{ id: string; created_at: unknown }>("select id, created_at from replay_runs order by created_at desc, id limit 1")).rows[0];
  if (!run) return null;
  const { rows } = await db.query<{ recall_number: string; recall_title: string; recall_date: string; outcome: keyof typeof OUTCOME; item_title: string | null; product: string | null }>(
    `select x.recall_number, x.recall_title, x.recall_date::text as recall_date, x.outcome, x.item_title,
            (select r.products->0->>'name' from recalls r where r.recall_number = x.recall_number order by r.recall_date desc limit 1) as product
     from replay_rows x where x.run_id = $1
     order by x.recall_date desc, x.recall_number desc`,
    [run.id],
  );
  return {
    runId: run.id,
    createdAt: new Date(run.created_at as string).toISOString(),
    rows: rows.map((r) => ({
      recallNumber: r.recall_number,
      recallTitle: r.recall_title,
      recallDate: r.recall_date,
      recallYear: Number(r.recall_date.slice(0, 4)),
      outcome: OUTCOME[r.outcome],
      product: r.product ?? r.recall_title,
      itemTitle: r.item_title,
    })),
  };
}
