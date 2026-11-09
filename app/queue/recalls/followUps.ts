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

export type FollowUpDateCheck = "OK" | "NOT_A_DATE" | "PAST" | "TOO_LATE" | "TOO_FAR";

/** The chart ends at least this far past today, so a date within it always shows. Claude's own advice is at most this many days. */
export const MAX_DAYS_AHEAD = 30;

/** The same rule for a date the owner confirms or drags to. The server runs it again before anything is saved. */
export function checkFollowUpDate(sale: TimelineSale, day: string, today: string): FollowUpDateCheck {
  if (!isCalendarDay(day)) return "NOT_A_DATE";
  if (day < today) return "PAST";
  if (hasOpenWindow(sale)) return day > lastFollowUpDay(sale.windowEnds) ? "TOO_LATE" : "OK";
  return day > addDays(today, MAX_DAYS_AHEAD) ? "TOO_FAR" : "OK";
}

/** One follow-up, as the timeline and the list under it show it. */
export interface FollowUpView {
  saleId: string;
  due: string;
  state: "proposed" | "confirmed";
  reason: string;
  hazardQuote: string;
  movedEarlier: boolean;
  /** The CPSC text this came from, sent back when it's confirmed. */
  snapshot: string;
}

const LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const dayLabel = (day: string) => LABEL.format(new Date(`${day}T00:00:00Z`));

export const MOVED_NOTE = "Moved earlier to stay inside the refund window.";

/** What a follow-up says, in the order it's read: why, in CPSC's words, and whether the window moved it. */
export function followUpLines(f: Pick<FollowUpView, "reason" | "hazardQuote" | "movedEarlier">): string[] {
  return [f.reason, `CPSC: "${f.hazardQuote}"`, ...(f.movedEarlier ? [MOVED_NOTE] : [])];
}

export const textChangedLine = (count: number) => (count === 1 ? "1 sale: CPSC changed this recall after it was checked, so no date is proposed." : `${count} sales: CPSC changed this recall after they were checked, so no date is proposed.`);

export const closingSoonLine = (count: number) => (count === 1 ? "1 sale: window closes too soon, refund now." : `${count} sales: window closes too soon, refund now.`);

/** The last day the date picker offers. */
export const latestDay = (sale: TimelineSale, today: string) => (hasOpenWindow(sale) ? lastFollowUpDay(sale.windowEnds) : addDays(today, MAX_DAYS_AHEAD));

/** The saved reminders still in force: on this timeline, for a family not yet reached. Answered, or refunded, and it retires. */
export function activeFollowUps<T extends { matchId: string }>(saved: readonly T[], sales: readonly TimelineSale[]): T[] {
  const open = new Set(sales.filter((s) => s.needsReaching).map((s) => s.id));
  return saved.filter((f) => open.has(f.matchId));
}

/** Runs one change at a time and drops any started meanwhile, so a late answer can't undo a dismissal or bring it back. */
export function oneAtATime() {
  let running = false;
  return async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    if (running) return undefined;
    running = true;
    try {
      return await work();
    } finally {
      running = false;
    }
  };
}
