// One line on the judge page, from what this app already holds: when CPSC was last checked, and the newest recall held.
import type { Queryable } from "../db/types";

export interface NewestRecall {
  recallNumber: string;
  recallDate: string;
}

export async function newestRecall(db: Queryable): Promise<NewestRecall | null> {
  const { rows } = await db.query<{ recall_number: string; recall_date: string }>("select recall_number, recall_date::text as recall_date from recalls order by recall_date desc, recall_number desc limit 1");
  return rows[0] ? { recallNumber: rows[0].recall_number, recallDate: rows[0].recall_date } : null;
}

/** A quiet poll writes nothing, so the running process knows the latest check. After a restart, this is the last one written. */
export async function lastGoodPull(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ at: Date | null }>("select max(finished_at) as at from cpsc_pulls where range_field = 'LastPublishDate' and status = 'ok'");
  return rows[0]?.at ? rows[0].at.toISOString() : null;
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
