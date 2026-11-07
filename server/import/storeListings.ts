// A store's public listings, checked the way an order file is: same matcher, same limits, deleted the same way.
// Listings aren't sales, so this can't reach a family or refund anyone, and nothing here says anything was sold.
import type { Db } from "../db/types";
import { runShopCheck } from "../match/run";
import { checkShopAgainstWarnings } from "../warnings/warnings";
import { readStoreListings, type StoreFeedDeps } from "./storeFeed";
import { createShop } from "./store";

const SOURCE = "Your store's public listings";

export async function importStoreListings(db: Db, input: { typed: string; today: string; deps?: StoreFeedDeps }): Promise<{ shopId: string; listings: number; complete: boolean }> {
  const read = await readStoreListings(input.typed, input.deps);
  const shopId = await createShop(db, { name: read.host, kind: "REAL" });
  try {
    await db.query("insert into shop_items (shop_id, title, listed, source) select $1, t, l, $4 from unnest($2::text[], $3::boolean[]) as u(t, l)", [
      shopId,
      read.listings.map((l) => l.title),
      read.listings.map((l) => l.listed),
      SOURCE,
    ]);
    await runShopCheck(db, shopId, { today: input.today });
  } catch (err) {
    await db.query("delete from shops where id = $1", [shopId]);
    throw err;
  }
  await checkShopAgainstWarnings(db, shopId);
  return { shopId, listings: read.listings.length, complete: read.complete };
}
