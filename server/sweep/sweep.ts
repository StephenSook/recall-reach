// For each recent recall, what the wider market lists under its product name. Run a few at a time from the hourly job and
// cached, so reading it never makes a call, and a limit can't break a page. A listing here is only something to review: a
// same-name product may be outside the recall's scope, and nothing here says otherwise.
import type { Queryable } from "../db/types";
import type { MarketListing, SearchMarket } from "./channel3";

/** The free tier is "sized for personal use", so this stays small. It still covers a few months of recalls in a day. */
export const SWEEP_PER_RUN = 5;
const LOOK_BACK_DAYS = 120;
const REFRESH_DAYS = 7;

export interface SweepRun {
  searched: number;
  failed: number;
  /** Still to do after this run. */
  left: number;
}

interface Due {
  recall_id: number;
  raw_sha256: string;
  title: string;
  products: { name?: string }[];
}

const DUE_SQL = `
  from recalls r left join recall_sweeps s using (recall_id)
  where r.recall_date >= $1::timestamptz - make_interval(days => $2)
    and (s.recall_id is null or s.status = 'failed' or s.searched_at < $1::timestamptz - make_interval(days => $3))`;

/** Only CPSC's public words go out: the recall's first product name, or its title. */
export const queryFor = (recall: Pick<Due, "title" | "products">) => (recall.products[0]?.name?.trim() || recall.title).slice(0, 200);

export async function sweepRecalls(db: Queryable, search: SearchMarket, now: Date, perRun = SWEEP_PER_RUN): Promise<SweepRun> {
  const at = now.toISOString();
  const { rows: due } = await db.query<Due>(
    `select r.recall_id, r.raw_sha256, r.title, r.products ${DUE_SQL} order by r.recall_date desc, r.recall_number desc limit $4`,
    [at, LOOK_BACK_DAYS, REFRESH_DAYS, perRun],
  );
  let searched = 0;
  let failed = 0;
  for (const recall of due) {
    const query = queryFor(recall);
    try {
      const { listings, asOf } = await search(query);
      await db.query(
        `insert into recall_sweeps (recall_id, recall_sha256, query, status, listings, index_as_of, searched_at)
         values ($1, $2, $3, 'ok', $4::jsonb, $5::timestamptz, $6::timestamptz)
         on conflict (recall_id) do update set recall_sha256 = $2, query = $3, status = 'ok', listings = $4::jsonb, index_as_of = $5::timestamptz, searched_at = $6::timestamptz`,
        [recall.recall_id, recall.raw_sha256, query, JSON.stringify(listings), asOf, at],
      );
      searched++;
    } catch (err) {
      failed++;
      // A refresh that fails keeps what it had. Only a first try leaves a failed row.
      await db.query(
        `insert into recall_sweeps (recall_id, recall_sha256, query, status, searched_at) values ($1, $2, $3, 'failed', $4::timestamptz)
         on conflict (recall_id) do nothing`,
        [recall.recall_id, recall.raw_sha256, query, at],
      );
      console.error(`market search failed: ${err instanceof Error ? err.message : "unknown error"}`);
      break; // if it is a limit, the rest would only add to it
    }
  }
  const { rows } = await db.query<{ n: string }>(`select count(*)::text as n ${DUE_SQL}`, [at, LOOK_BACK_DAYS, REFRESH_DAYS]);
  return { searched, failed, left: Number(rows[0].n) };
}

export interface RecallSweep {
  query: string;
  status: "ok" | "failed";
  listings: MarketListing[];
  indexAsOf: string | null;
  searchedAt: string;
  /** CPSC has edited the recall since this search. */
  recallChanged: boolean;
}

export async function readSweep(db: Queryable, recallNumber: string): Promise<RecallSweep | null> {
  const { rows } = await db.query<{ query: string; status: "ok" | "failed"; listings: MarketListing[]; index_as_of: string | Date | null; searched_at: string | Date; changed: boolean }>(
    `select s.query, s.status, s.listings, s.index_as_of, s.searched_at, s.recall_sha256 <> r.raw_sha256 as changed
     from recall_sweeps s join recalls r using (recall_id) where r.recall_number = $1`,
    [recallNumber],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    query: row.query,
    status: row.status,
    listings: row.listings,
    indexAsOf: row.index_as_of ? new Date(row.index_as_of).toISOString() : null,
    searchedAt: new Date(row.searched_at).toISOString(),
    recallChanged: row.changed,
  };
}
