// One changed fact: the sale date. Both verdicts come from salePath, the rule the queue itself runs, so the page can't
// say something the queue wouldn't. Pure: nothing is read or saved, and nothing goes to PayPal or Claude.
import { salePath, type SalePath } from "@/server/match/verdict";

export function whatIfPaths(soldOn: string, movedTo: string, recallDate: string): { original: SalePath; moved: SalePath } {
  return { original: salePath(soldOn, recallDate), moved: salePath(movedTo, recallDate) };
}

/** The calendar day before a YYYY-MM-DD date, in UTC so no local clock can shift it. */
export function dayBefore(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}
