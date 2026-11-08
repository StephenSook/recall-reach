// What the queue says after each step of connecting a shop's PayPal account. Plain words, and PayPal's own when it refused.
import type { Refreshed } from "./connectFlow";

/** What a shop sees when its link is already being changed, or the site is already busy with other shops' links. */
export const BUSY = "A check with PayPal is already running. Try again in a minute.";

export function refreshedMessage(r: Refreshed): string {
  if (r.state === "NOT_STARTED") return "Connect your PayPal account first.";
  if (r.state === "WAITING") return "PayPal hasn't finished connecting your account yet. Check again in a minute.";
  if (r.state === "REFUSED") return `PayPal's status couldn't be read. ${r.refusal}`;
  if (r.state === "SUPERSEDED") return "Another check with PayPal finished after this one started. Check again to see the newest answer.";
  if ("refusal" in r.sales) return `Your PayPal account is connected, but its sales couldn't be read, so refunds stay notice-only. ${r.sales.refusal}`;
  if (!r.sales.complete) return "Your PayPal account is connected, but PayPal didn't answer for all of its sales. Refunds wait until a full read. The calls below show PayPal's answers.";
  return `Your PayPal account is connected. ${r.sales.payments} payments were read from it and joined to your order file.`;
}
