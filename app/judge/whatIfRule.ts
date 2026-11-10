// One changed fact: the sale date. Both verdicts come from salePath, the rule the queue itself runs, so the page can't
// say something the queue wouldn't. Pure: nothing is read or saved, and nothing goes to PayPal or Claude.
import { salePath, type SalePath } from "@/server/match/verdict";

/** A whole YYYY-MM-DD date that exists on the calendar: not empty, not half typed, not Feb 30. */
export function isCalendarDate(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const at = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
}

/** moved is null until the tried date is a whole calendar date, so a cleared or half-typed field shows no verdict. */
export function whatIfPaths(soldOn: string, movedTo: string, recallDate: string): { original: SalePath; moved: SalePath | null } {
  return { original: salePath(soldOn, recallDate), moved: isCalendarDate(movedTo) ? salePath(movedTo, recallDate) : null };
}

/** The calendar day before a YYYY-MM-DD date, in UTC so no local clock can shift it. */
export function dayBefore(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}
