// Connecting a shop's own PayPal account, start to finish. PayPal's refusals are kept in PayPal's own words, with its
// debug id, and nothing works around them.
import type { Db } from "../db/types";
import { PayPalApiError } from "../paypal/client";
import { createReferral, isConnected, readSellerStatus, type PlatformEnv } from "../paypal/platform";
import type { RecordKey } from "../privacy/recordKey";
import type { SearchCoverage } from "../paypal/transactions";
import { checkConnectedShop, readConnectedShopSales } from "./connectedSales";
import { clearSellerStatus, readConnection, recordConnectRefusal, recordSalesRead, reserveStatusRead, saveSellerStatus, shopsLinkedTo, startConnection, trackingIdFor, withConnectionLock } from "./paypalConnection";

/** PayPal's answer as a person can read it: the status, PayPal's issue name and its debug id. */
export function refusalText(err: unknown): string {
  if (err instanceof PayPalApiError) return `PayPal answered HTTP ${err.status}${err.issue ? `, ${err.issue}` : ""}${err.debugId ? ` (PayPal-Debug-Id ${err.debugId})` : ""}`;
  return err instanceof Error && err.message.startsWith("PayPal's answer") ? err.message : "PayPal could not be reached.";
}

export async function startConnect(db: Db, platform: PlatformEnv, input: { shopId: string; recordKey: RecordKey; returnUrl: string; now: Date }): Promise<{ actionUrl: string } | { refusal: string }> {
  const trackingId = trackingIdFor(input.recordKey, input.shopId);
  return withConnectionLock(db, input.shopId, async (tx) => {
    await startConnection(tx, { shopId: input.shopId, trackingId, now: input.now });
    try {
      return await createReferral(platform.client, { trackingId, returnUrl: input.returnUrl });
    } catch (err) {
      const refusal = refusalText(err);
      await recordConnectRefusal(tx, { shopId: input.shopId, refusal });
      return { refusal };
    }
  });
}

/** How long a check with PayPal may spend reading the shop's sales while it holds the shop's lock. */
export const SALES_READ_MS = 45_000;

export type Refreshed =
  | { state: "NOT_STARTED" }
  | { state: "WAITING" }
  /** A check asked after this one has already landed, or the shop started connecting again: this answer is out of date. */
  | { state: "SUPERSEDED" }
  | { state: "REFUSED"; refusal: string }
  | { state: "CONNECTED"; sales: { complete: boolean; payments: number } | { refusal: string } };

/**
 * Reads the seller's status from PayPal, and, once PayPal says connected, the shop's own sales, alone for the shop. The
 * recall check that follows runs after the shop's lock is released, so a large file can't keep the lock held.
 */
export async function refreshConnection(db: Db, platform: PlatformEnv, input: { shopId: string; recordKey: RecordKey; secret: string; now: Date }): Promise<Refreshed> {
  const salesRead: { coverage?: SearchCoverage } = {};
  const refreshed = await withConnectionLock(db, input.shopId, async (tx): Promise<Refreshed> => {
    const connection = await readConnection(tx, { shopId: input.shopId, secret: input.secret });
    if (!connection) return { state: "NOT_STARTED" };
    // Reserved immediately before asking PayPal, so its place in line is the moment it asked.
    const read = await reserveStatusRead(tx, input.shopId);
    if (!read) return { state: "NOT_STARTED" };
    let status;
    try {
      status = await readSellerStatus(platform.client, { partnerId: platform.partnerId, trackingId: connection.trackingId, platformClientId: platform.clientId });
    } catch (err) {
      const refusal = refusalText(err);
      await recordConnectRefusal(tx, { shopId: input.shopId, refusal });
      return { state: "REFUSED", refusal };
    }
    if (!status) return (await clearSellerStatus(tx, { shopId: input.shopId, read, now: input.now })) ? { state: "WAITING" } : { state: "SUPERSEDED" };
    if (!(await saveSellerStatus(tx, { shopId: input.shopId, read, status, secret: input.secret, recordKey: input.recordKey, now: input.now }))) return { state: "SUPERSEDED" };
    if (!isConnected(status)) return { state: "WAITING" };
    // PayPal's answer about the seller stands whatever happens to the sales read: a failure there rolls back to here.
    await tx.query("savepoint seller_saved");
    try {
      // Still inside the lock: nothing can change the link while the seller's sales are read and saved.
      const sales = await readConnectedShopSales(tx, platform.actingFor(status.merchantId), { shopId: input.shopId, now: input.now, notAfter: input.now.getTime() + SALES_READ_MS });
      salesRead.coverage = sales.coverage;
      return { state: "CONNECTED", sales: { complete: sales.complete, payments: sales.payments } };
    } catch (err) {
      await tx.query("rollback to savepoint seller_saved");
      // Whatever an earlier read established, this one didn't finish: refunds wait for one that does.
      await recordSalesRead(tx, { shopId: input.shopId, complete: false, now: input.now });
      // Connected, but the sales didn't arrive: its refunds stay notice-only, and the page says why. Search failures come
      // back as failed windows, not throws, so anything else here is this site failing to save them, and says so.
      const refusal = err instanceof PayPalApiError ? refusalText(err) : "The sales PayPal returned couldn't be saved here.";
      await recordConnectRefusal(tx, { shopId: input.shopId, refusal: `Connected, but the shop's sales couldn't be read. ${refusal}` });
      return { state: "CONNECTED", sales: { refusal } };
    }
  });
  if (!salesRead.coverage) return refreshed;
  try {
    await checkConnectedShop(db, { shopId: input.shopId, now: input.now, coverage: salesRead.coverage });
  } catch {
    const refusal = "The sales were read, but checking them against recalls failed here. Check with PayPal again.";
    await recordConnectRefusal(db, { shopId: input.shopId, refusal: `Connected, but the shop's sales couldn't be checked. ${refusal}` });
    return { state: "CONNECTED", sales: { refusal } };
  }
  return refreshed;
}

/**
 * PayPal's webhook said a seller took its consent back. A webhook's body is covered only by a CRC, so this acts only on
 * PayPal's own status for each shop linked to that seller, read again under that shop's lock, and applies whatever PayPal
 * answers now: still connected (kept), connected as another seller (replaced, the new one saved), or not (forgotten: the
 * seller and its payments go, the row stays for the next check). If PayPal can't be read, this throws, nothing changes,
 * the delivery fails and PayPal sends it again.
 */
export async function confirmRevoked(
  db: Db,
  platform: PlatformEnv,
  input: { merchantId: string; recordKey: RecordKey; secret: string; now?: Date },
): Promise<{ forgotten: number; kept: number; replaced: number }> {
  const counts = { forgotten: 0, kept: 0, replaced: 0 };
  for (const shop of await shopsLinkedTo(db, input.recordKey("paypal-merchant", input.merchantId))) {
    const outcome = await withConnectionLock(db, shop.shopId, async (tx): Promise<keyof typeof counts | null> => {
      const read = await reserveStatusRead(tx, shop.shopId);
      if (!read) return null;
      const now = input.now ?? new Date();
      const status = await readSellerStatus(platform.client, { partnerId: platform.partnerId, trackingId: shop.trackingId, platformClientId: platform.clientId });
      if (status && isConnected(status)) {
        if (!(await saveSellerStatus(tx, { shopId: shop.shopId, read, status, secret: input.secret, recordKey: input.recordKey, now }))) return null;
        return status.merchantId === input.merchantId ? "kept" : "replaced";
      }
      return (await clearSellerStatus(tx, { shopId: shop.shopId, read, now })) ? "forgotten" : null;
    }, { lane: "revoke" });
    if (outcome) counts[outcome] += 1;
  }
  return counts;
}
