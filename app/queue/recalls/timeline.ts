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
  /** How its bar reads: what can happen next, not only what the dates say. */
  tone: "notice" | "check" | "refund";
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

type Sold = QueueRow & { orderedOn: string; salePath: NonNullable<QueueRow["salePath"]> };

/** The same bar the refund itself has to clear: a confirmed match. Dates alone never make a sale a notice or a refund. */
function readingOf(row: Sold, windowEnds: string, today: string): Pick<TimelineSale, "tone" | "meaning"> {
  if (row.verdict !== "MATCH" || row.strength !== "CONFIRMED" || row.joinState === "AMBIGUOUS_JOIN") return { tone: "check", meaning: "Not confirmed yet: a check comes first" };
  if (row.salePath === "NOTICE_ONLY") return { tone: "notice", meaning: "Sold before the recall: a notice, not a refund" };
  if (row.salePath === "REVIEW") return { tone: "check", meaning: "Sold on the recall date: a person checks the date" };
  // The bar counts from the shop's order date, and PayPal's own date and time decide. So the last day doesn't read as inside.
  if (windowEnds <= today) return { tone: "notice", meaning: "Sold after the recall, and 180 days from its order date have passed" };
  return { tone: "refund", meaning: "Sold after the recall, within 180 days of its order date" };
}

/** Null when this shop has no sale of this recall to draw. A cleared sale gets nothing, and a listing hasn't sold, so neither is on the line. */
export function timelineFor(rows: QueueRow[], recallNumber: string, today: string): Timeline | null {
  const sold = rows.filter((r): r is Sold => r.recallNumber === recallNumber && r.verdict !== "CLEARED" && !r.isListing && Boolean(r.orderedOn) && r.salePath !== null);
  const first = sold[0];
  if (!first) return null;
  const sales = sold
    .map((r) => {
      const windowEnds = addDays(r.orderedOn, REFUND_WINDOW_DAYS);
      return { id: r.matchId, title: r.itemTitle, orderedOn: r.orderedOn, windowEnds, ...readingOf(r, windowEnds, today) };
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
