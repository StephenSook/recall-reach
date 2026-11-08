// One line on the judge page, from what this app already holds: when CPSC was last checked, and the newest recall held.
import type { Queryable } from "../db/types";

export interface NewestRecall {
  recallNumber: string;
  recallDate: string;
}

export interface HeldReading {
  newest: NewestRecall | null;
  /** The last good pull written. A quiet poll writes nothing, so the running process knows of a later check. */
  written: string | null;
}

/** One statement, so one connection however busy the pool is. */
export async function readHeld(db: Queryable): Promise<HeldReading> {
  const { rows } = await db.query<{ recall_number: string | null; recall_date: string | null; written: Date | null }>(
    `select n.recall_number, n.recall_date::text as recall_date,
       (select max(finished_at) from cpsc_pulls where range_field = 'LastPublishDate' and status = 'ok') as written
     from (select 1) one
     left join lateral (select recall_number, recall_date from recalls order by recall_date desc, recall_number desc limit 1) n on true`,
  );
  const row = rows[0];
  return {
    newest: row?.recall_number && row.recall_date ? { recallNumber: row.recall_number, recallDate: row.recall_date } : null,
    written: row?.written ? row.written.toISOString() : null,
  };
}

/** The judge page is public and the pool is small: visits share one read, and a failed read isn't kept. */
export function createHeldReading(keepMs: number) {
  let held: { at: number; reading: Promise<HeldReading | null> } | null = null;
  return (db: Queryable, now: number): Promise<HeldReading | null> => {
    if (held && now - held.at < keepMs) return held.reading;
    const entry = {
      at: now,
      reading: readHeld(db).catch(() => {
        if (held === entry) held = null;
        return null;
      }),
    };
    held = entry;
    return entry.reading;
  };
}

function ago(at: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const onDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function liveNowLine(input: { checkedAt: string | null; newest: NewestRecall | null; now: Date }): string {
  const check = input.checkedAt ? `Last CPSC check ${ago(input.checkedAt, input.now)}.` : "Last CPSC check: not yet.";
  if (input.newest) return `${check} Newest recall held: ${input.newest.recallNumber}, from ${onDay(input.newest.recallDate)}.`;
  return input.checkedAt ? `${check} Newest recall held: not yet.` : check;
}
