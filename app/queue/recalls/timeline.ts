// One recall's sales on one time axis. Each bar is a sale's 180-day refund window, from the shop's own order date, never a
// date from PayPal. The app only offers a refund for a sale made after the recall and still inside its window, so this is
// that rule, drawn.
import type { QueueRow } from "@/server/queue/queue";

const DAY_MS = 86_400_000;
export const REFUND_WINDOW_DAYS = 180;
/** Room at each end of the axis: a date line's label is about this wide at the axis's tightest. */
const AXIS_ROOM_DAYS = 35;
/** Squeezed into the width past this, the axis's month labels stop fitting, so it scrolls instead. */
const MAX_FITTED_DAYS = 400;

export interface TimelineSale {
  id: string;
  title: string;
  orderedOn: string;
  windowEnds: string;
  path: "NOTICE_ONLY" | "REVIEW" | "REFUND_ELIGIBLE" | null;
  /** In words: what this sale's place on the line means. */
  meaning: string;
}

export interface Timeline {
  recallNumber: string;
  recallTitle: string;
  recallDate: string;
  today: string;
  sales: TimelineSale[];
  /** Where the axis starts and ends, with room around the first and last date. */
  from: string;
  to: string;
  /** Whether the whole axis can be fitted to the width. */
  fits: boolean;
}

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function meaningOf(path: TimelineSale["path"], windowEnds: string, today: string): string {
  if (path === "NOTICE_ONLY") return "Sold before the recall: a notice, not a refund";
  if (path === "REVIEW") return "Sold on the recall date: a person checks the date";
  if (path === "REFUND_ELIGIBLE") return windowEnds < today ? "Sold after the recall, and its 180 days are over" : "Sold after the recall, and inside its 180 days";
  return "No sale date to place";
}

/** Null when this shop has no sale of this recall to draw. A listing that hasn't sold has no date, so it isn't on the line. */
export function timelineFor(rows: QueueRow[], recallNumber: string, today: string): Timeline | null {
  const mine = rows.filter((r) => r.recallNumber === recallNumber);
  const sold = mine.filter((r): r is QueueRow & { orderedOn: string } => Boolean(r.orderedOn));
  const first = sold[0];
  if (!first) return null;
  const sales = sold
    .map((r) => {
      const windowEnds = addDays(r.orderedOn, REFUND_WINDOW_DAYS);
      return { id: r.matchId, title: r.itemTitle, orderedOn: r.orderedOn, windowEnds, path: r.salePath, meaning: meaningOf(r.salePath, windowEnds, today) };
    })
    .sort((a, b) => a.orderedOn.localeCompare(b.orderedOn));
  const dates = [first.recallDate, today, ...sales.flatMap((s) => [s.orderedOn, s.windowEnds])].sort();
  const from = addDays(dates[0], -AXIS_ROOM_DAYS);
  const to = addDays(dates[dates.length - 1], AXIS_ROOM_DAYS);
  return {
    recallNumber,
    recallTitle: first.recallTitle,
    recallDate: first.recallDate,
    today,
    sales,
    from,
    to,
    fits: (Date.parse(to) - Date.parse(from)) / DAY_MS <= MAX_FITTED_DAYS,
  };
}
