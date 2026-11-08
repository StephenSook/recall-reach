// What the queue's PayPal panel says. "Connected" appears only when PayPal's own answer says so.
import { ranAt } from "@/app/replay/labels";
import { REFUND_SCOPE } from "@/server/paypal/platform";
import type { Connection } from "@/server/shop/paypalConnection";

export type ConnectAction = "connect" | "check" | "disconnect";

export function connectPanel(conn: Connection | null, opts: { setUp: boolean }): { lines: string[]; actions: ConnectAction[] } {
  if (!opts.setUp) return { lines: ["Refunds from your own PayPal account aren't set up on this site yet. Notices work now."], actions: [] };
  const refusal = conn?.refusal ? [`PayPal's answer: ${conn.refusal}`] : [];
  if (!conn) {
    return {
      lines: ["Connect your PayPal account so refunds can go from it. You approve each refund here first. You sign in and agree on PayPal's own page, so this site never sees your password."],
      actions: ["connect"],
    };
  }
  if (conn.connected && conn.status && conn.readAt) {
    return {
      lines: [`Connected. PayPal said, ${ranAt(conn.readAt)}, that payments can be received, the account's email is confirmed and refunds were granted to this site.`, ...refusal],
      actions: ["check", "disconnect"],
    };
  }
  const s = conn.status;
  const missing = s
    ? [!s.paymentsReceivable && "payments can't be received yet", !s.primaryEmailConfirmed && "the account's email isn't confirmed", !s.scopes.includes(REFUND_SCOPE) && "refunds weren't granted to this site"].filter(
        (m): m is string => Boolean(m),
      )
    : [];
  const said = s && conn.readAt ? `Not connected yet. PayPal said, ${ranAt(conn.readAt)}: ${missing.join("; ")}.` : `You started connecting ${ranAt(conn.startedAt)}. PayPal hasn't said your account is connected yet.`;
  return { lines: [said, ...refusal], actions: ["check", "connect", "disconnect"] };
}
