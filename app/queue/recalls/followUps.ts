// Where a follow-up goes on a sale's row. Claude only says how soon a hazard warrants one, from CPSC's public text. It never sees
// a sale, so this code sets each date, from the shop's own order date, and keeps it clear of the end of the refund window.
import type { TimelineSale } from "./timeline";

const DAY_MS = 86_400_000;
/** A follow-up this close to the end of the window would leave no time to act on what the family says. */
export const DAYS_BEFORE_WINDOW_ENDS = 7;

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export const lastFollowUpDay = (windowEnds: string) => addDays(windowEnds, -DAYS_BEFORE_WINDOW_ENDS);

/** Only a sale with a refund still open has a window to stay inside. */
const hasOpenWindow = (sale: TimelineSale) => sale.tone === "refund";

export interface ProposedFollowUp {
  saleId: string;
  due: string;
  /** The window ended sooner than Claude's days would have, so the date came forward. */
  movedEarlier: boolean;
}

export function placeFollowUps(sales: readonly TimelineSale[], withinDays: number, today: string): { proposals: ProposedFollowUp[]; closingSoon: number } {
  const proposals: ProposedFollowUp[] = [];
  let closingSoon = 0;
  const asked = addDays(today, withinDays);
  for (const sale of sales) {
    if (!sale.needsReaching) continue;
    if (!hasOpenWindow(sale)) {
      proposals.push({ saleId: sale.id, due: asked, movedEarlier: false });
      continue;
    }
    const last = lastFollowUpDay(sale.windowEnds);
    if (last < today) {
      closingSoon++;
      continue;
    }
    proposals.push(asked <= last ? { saleId: sale.id, due: asked, movedEarlier: false } : { saleId: sale.id, due: last, movedEarlier: true });
  }
  return { proposals, closingSoon };
}

const isCalendarDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export type FollowUpDateCheck = "OK" | "NOT_A_DATE" | "PAST" | "TOO_LATE";

/** The same rule for a date the owner confirms or drags to. The server runs it again before anything is saved. */
export function checkFollowUpDate(sale: TimelineSale, day: string, today: string): FollowUpDateCheck {
  if (!isCalendarDay(day)) return "NOT_A_DATE";
  if (day < today) return "PAST";
  if (hasOpenWindow(sale) && day > lastFollowUpDay(sale.windowEnds)) return "TOO_LATE";
  return "OK";
}
