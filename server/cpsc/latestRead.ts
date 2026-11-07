// One line for the home page. The read's time comes from the poll held in memory, and the count is read at most every few hours,
// so a visit to the home page doesn't wake the database on its free plan.
import { ranAt } from "@/app/replay/labels";
import type { Queryable } from "../db/types";
import { CHECK_FROM } from "../match/run";

const MAX_READ_AGE_MS = 2.5 * 3_600_000;
const COUNT_LASTS_MS = 6 * 3_600_000;

let held: { count: number; at: number } | null = null;

export async function heldRecalls(db: Queryable, now: number = Date.now()): Promise<number> {
  if (held && now - held.at < COUNT_LASTS_MS) return held.count;
  const { rows } = await db.query<{ n: string }>("select count(*)::text as n from recalls where recall_date >= $1::date", [CHECK_FROM]);
  held = { count: Number(rows[0].n), at: now };
  return held.count;
}

/** Left out when it's stale, when the last read failed, or when the count can't be read: the home page has no warning to give here. */
export async function latestReadLine(poll: { lastPollAt: string | null; lastPollOk: boolean | null }, count: () => Promise<number>, now: Date = new Date()): Promise<string | null> {
  if (!poll.lastPollOk || !poll.lastPollAt || now.getTime() - Date.parse(poll.lastPollAt) > MAX_READ_AGE_MS) return null;
  try {
    const recalls = await count();
    return recalls > 0 ? `Latest CPSC read ${ranAt(poll.lastPollAt)}. ${recalls.toLocaleString("en-US")} recalls since ${CHECK_FROM.slice(0, 4)}.` : null;
  } catch {
    return null;
  }
}
