import { createHash } from "node:crypto";
import type { Db, Queryable } from "../db/types";
import { fetchRecalls, type FetchDeps, type RecallRange } from "./fetch";
import { parseRecalls, type InvalidRecall, type ParsedRecall } from "./schema";

export interface PullSummary {
  pullId: number;
  range: RecallRange;
  status: "ok" | "partial";
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  invalid: InvalidRecall[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

/** SHA-256 of a record's canonical JSON (keys sorted): identifies the exact CPSC snapshot. */
export function snapshotHash(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(raw))).digest("hex");
}

/** One row per recall ID; if CPSC repeats one, keep the most recently published copy. */
function latestPerRecall(records: ParsedRecall[]): ParsedRecall[] {
  const byId = new Map<number, ParsedRecall>();
  for (const r of records) {
    const seen = byId.get(r.recall.recallId);
    if (!seen || r.recall.lastPublishDate >= seen.recall.lastPublishDate) byId.set(r.recall.recallId, r);
  }
  return [...byId.values()];
}

const UPSERT_SQL = `
  insert into recalls (
    recall_id, recall_number, recall_date, last_publish_date, title, description, url,
    products, hazards, remedies, remedy_options, retailers, images, raw, raw_sha256
  )
  select
    (r->>'recallId')::integer, r->>'recallNumber', (r->>'recallDate')::date,
    (r->>'lastPublishDate')::timestamp, r->>'title', r->>'description', r->>'url',
    r->'products', r->'hazards', r->'remedies', r->'remedyOptions', r->'retailers', r->'images',
    r->'raw', r->>'rawSha256'
  from jsonb_array_elements($1::jsonb) as r
  on conflict (recall_id) do update set
    recall_number = excluded.recall_number,
    recall_date = excluded.recall_date,
    last_publish_date = excluded.last_publish_date,
    title = excluded.title,
    description = excluded.description,
    url = excluded.url,
    products = excluded.products,
    hazards = excluded.hazards,
    remedies = excluded.remedies,
    remedy_options = excluded.remedy_options,
    retailers = excluded.retailers,
    images = excluded.images,
    raw = excluded.raw,
    raw_sha256 = excluded.raw_sha256,
    updated_at = now()
  where recalls.raw_sha256 is distinct from excluded.raw_sha256
  returning (xmax = 0) as inserted`;

/** Inserts new recalls and updates changed ones; a record whose snapshot hash is unchanged is left alone. */
export async function upsertRecalls(
  db: Queryable,
  records: ParsedRecall[],
): Promise<{ inserted: number; updated: number; unchanged: number }> {
  const rows = latestPerRecall(records).map(({ recall, raw }) => ({ ...recall, raw, rawSha256: snapshotHash(raw) }));
  if (rows.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
  const { rows: written } = await db.query<{ inserted: boolean }>(UPSERT_SQL, [JSON.stringify(rows)]);
  const inserted = written.filter((w) => w.inserted).length;
  const updated = written.length - inserted;
  return { inserted, updated, unchanged: rows.length - written.length };
}

/**
 * Pulls one date range from the CPSC API into the recalls table and logs the pull in cpsc_pulls.
 * Invalid records are reported (status "partial"), never dropped silently. A failed fetch is
 * logged as "failed" and rethrown.
 */
export async function pullRecalls(db: Db, range: RecallRange, deps: FetchDeps = {}): Promise<PullSummary> {
  const { rows } = await db.query<{ id: number }>(
    `insert into cpsc_pulls (range_field, range_start, range_end, status)
     values ($1, $2, $3, 'running') returning id`,
    [range.field, range.start, range.end],
  );
  const pullId = Number(rows[0].id);

  try {
    const payload = await fetchRecalls(range, deps);
    const { valid, invalid } = parseRecalls(payload);
    const counts = await db.transaction((tx) => upsertRecalls(tx, valid));
    const status = invalid.length > 0 ? "partial" : "ok";
    await db.query(
      `update cpsc_pulls set finished_at = now(), status = $2, fetched = $3, inserted = $4, updated = $5,
         unchanged = $6, invalid = $7, invalid_detail = $8::jsonb
       where id = $1`,
      [pullId, status, payload.length, counts.inserted, counts.updated, counts.unchanged, invalid.length, JSON.stringify(invalid)],
    );
    return { pullId, range, status, fetched: payload.length, ...counts, invalid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .query(`update cpsc_pulls set finished_at = now(), status = 'failed', error = $2 where id = $1`, [
        pullId,
        message.slice(0, 2000),
      ])
      .catch((logErr: unknown) => {
        console.error(`could not mark CPSC pull ${pullId} failed:`, logErr instanceof Error ? logErr.message : logErr);
      });
    throw err;
  }
}
