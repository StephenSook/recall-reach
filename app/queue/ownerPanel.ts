// What the queue says about signing in with PayPal. "The same account your refunds go from" only when that was measured.
import { ranAt } from "@/app/replay/labels";
import type { OwnerLink } from "@/server/owner/ownerLink";
import type { ShopLifetime } from "@/server/shop/lifetime";

export function ownerPanel(link: OwnerLink | null, opts: { setUp: boolean; lifetime?: ShopLifetime | null; now?: Date }): { lines: string[]; action: "link" | "unlink" | null } {
  if (!opts.setUp && !link) return { lines: ["Signing in with PayPal isn't set up on this site yet."], action: null };
  if (!link) {
    return {
      lines: [
        "Link your PayPal login, so Sign in with PayPal on the Check page opens this shop from any browser. Linking also keeps this shop, its order file and its receipts past 7 days: until you delete them, or a year passes with no PayPal sign-in. Only a keyed hash of your PayPal account id is kept.",
      ],
      action: "link",
    };
  }
  const seller = link.isSeller === true ? " It's the same PayPal account your refunds go from." : link.isSeller === false ? " It's not the PayPal account your refunds go from." : "";
  const life = opts.lifetime;
  const kept = life?.keptByOwner
    ? [
        `Your shop is kept until you delete it, or a year passes with no PayPal sign-in. It's due to be deleted after ${ranAt(life.deletesAfter.toISOString())}.`,
        // Unlinking brings back the 7-day rule, which for an older shop has already passed: the hourly purge takes it next.
        life.unkeptDeletesAfter.getTime() > (opts.now ?? new Date()).getTime()
          ? `If you unlink, its data is deleted after ${ranAt(life.unkeptDeletesAfter.toISOString())}.`
          : "If you unlink, its data is deleted within the hour.",
      ]
    : [];
  return { lines: [`Linked to your PayPal login ${ranAt(link.linkedAt)}.`, ...(seller ? [seller.trim()] : []), ...kept], action: "unlink" };
}
