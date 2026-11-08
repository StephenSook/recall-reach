// When a shop's data is deleted: the one rule the purge (purgeOldOwnShops, purgeOldDemoShops) and every screen share. A
// demo shop at DEMO_SHOP_HOURS. A real shop 7 days after it joined, or, once its owner links a PayPal login, a year after
// the last link or sign-in, whichever is later.
import type { Queryable } from "../db/types";
import { DEMO_SHOP_HOURS, KEPT_SHOP_DAYS, OWN_FILE_DAYS } from "../import/ownFile";

const HOUR = 3_600_000;

export interface ShopLifetime {
  deletesAfter: Date;
  /** Kept past its 7 days because its owner links a PayPal login. */
  keptByOwner: boolean;
  /** When it would be deleted without that: what unlinking would bring back. */
  unkeptDeletesAfter: Date;
}

export function lifetimeOf(shop: { kind: string; createdAt: Date; ownerLastAt: Date | null }): ShopLifetime {
  if (shop.kind === "DEMO") {
    const at = new Date(shop.createdAt.getTime() + DEMO_SHOP_HOURS * HOUR);
    return { deletesAfter: at, keptByOwner: false, unkeptDeletesAfter: at };
  }
  const unkept = new Date(shop.createdAt.getTime() + OWN_FILE_DAYS * 24 * HOUR);
  if (!shop.ownerLastAt) return { deletesAfter: unkept, keptByOwner: false, unkeptDeletesAfter: unkept };
  const kept = new Date(shop.ownerLastAt.getTime() + KEPT_SHOP_DAYS * 24 * HOUR);
  return { deletesAfter: kept > unkept ? kept : unkept, keptByOwner: true, unkeptDeletesAfter: unkept };
}

export async function shopLifetime(db: Queryable, shopId: string): Promise<ShopLifetime | null> {
  const { rows } = await db.query<{ kind: string; created_at: Date; owner_last_at: Date | null }>(
    "select kind, created_at, case when owner_payer_hmac is not null then greatest(owner_linked_at, owner_signed_in_at) end as owner_last_at from shops where id = $1",
    [shopId],
  );
  const r = rows[0];
  return r ? lifetimeOf({ kind: r.kind, createdAt: new Date(r.created_at), ownerLastAt: r.owner_last_at ? new Date(r.owner_last_at) : null }) : null;
}
