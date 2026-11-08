// What the queue says about signing in with PayPal. "The same account your refunds go from" only when that was measured.
import { ranAt } from "@/app/replay/labels";
import type { OwnerLink } from "@/server/owner/ownerLink";

export function ownerPanel(link: OwnerLink | null, opts: { setUp: boolean }): { lines: string[]; action: "link" | "unlink" | null } {
  if (!opts.setUp && !link) return { lines: ["Signing in with PayPal isn't set up on this site yet."], action: null };
  if (!link) {
    return {
      lines: ["Link your PayPal login, so Sign in with PayPal on the Check page opens this shop from any browser. Only a keyed hash of your PayPal account id is kept."],
      action: "link",
    };
  }
  const seller = link.isSeller === true ? " It's the same PayPal account your refunds go from." : link.isSeller === false ? " It's not the PayPal account your refunds go from." : "";
  return { lines: [`Linked to your PayPal login ${ranAt(link.linkedAt)}.`, ...(seller ? [seller.trim()] : [])], action: "unlink" };
}
