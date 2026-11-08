// Connecting a shop's own PayPal account, start to finish. PayPal's refusals are kept in PayPal's own words, with its
// debug id, and nothing works around them.
import type { Db } from "../db/types";
import { PayPalApiError } from "../paypal/client";
import { createReferral, isConnected, readSellerStatus, type PlatformEnv } from "../paypal/platform";
import type { RecordKey } from "../privacy/recordKey";
import { readConnectedShopSales } from "./connectedSales";
import { clearSellerStatus, disconnectShop, readConnection, recordConnectRefusal, saveSellerStatus, shopsLinkedTo, startConnection, trackingIdFor } from "./paypalConnection";

/** PayPal's answer as a person can read it: the status, PayPal's issue name and its debug id. */
export function refusalText(err: unknown): string {
  if (err instanceof PayPalApiError) return `PayPal answered HTTP ${err.status}${err.issue ? `, ${err.issue}` : ""}${err.debugId ? ` (PayPal-Debug-Id ${err.debugId})` : ""}`;
  return err instanceof Error && err.message.startsWith("PayPal's answer") ? err.message : "PayPal could not be reached.";
}

export async function startConnect(db: Db, platform: PlatformEnv, input: { shopId: string; recordKey: RecordKey; returnUrl: string; now: Date }): Promise<{ actionUrl: string } | { refusal: string }> {
  const trackingId = trackingIdFor(input.recordKey, input.shopId);
  await startConnection(db, { shopId: input.shopId, trackingId, now: input.now });
  try {
    return await createReferral(platform.client, { trackingId, returnUrl: input.returnUrl });
  } catch (err) {
    const refusal = refusalText(err);
    await recordConnectRefusal(db, { shopId: input.shopId, refusal });
    return { refusal };
  }
}

export type Refreshed = { state: "NOT_STARTED" } | { state: "WAITING" } | { state: "REFUSED"; refusal: string } | { state: "CONNECTED"; sales: { complete: boolean; payments: number } | { refusal: string } };

/** Reads the seller's status from PayPal, and, once PayPal says connected, the shop's own sales. */
export async function refreshConnection(db: Db, platform: PlatformEnv, input: { shopId: string; recordKey: RecordKey; secret: string; now: Date }): Promise<Refreshed> {
  const connection = await readConnection(db, { shopId: input.shopId, secret: input.secret });
  if (!connection) return { state: "NOT_STARTED" };
  let status;
  try {
    status = await readSellerStatus(platform.client, { partnerId: platform.partnerId, trackingId: connection.trackingId, platformClientId: platform.clientId });
  } catch (err) {
    const refusal = refusalText(err);
    await recordConnectRefusal(db, { shopId: input.shopId, refusal });
    return { state: "REFUSED", refusal };
  }
  if (!status) {
    if (connection.status) await clearSellerStatus(db, { shopId: input.shopId, now: input.now });
    return { state: "WAITING" };
  }
  await saveSellerStatus(db, { shopId: input.shopId, status, secret: input.secret, recordKey: input.recordKey, now: input.now });
  if (!isConnected(status)) return { state: "WAITING" };
  try {
    return { state: "CONNECTED", sales: await readConnectedShopSales(db, platform.actingFor(status.merchantId), { shopId: input.shopId, now: input.now }) };
  } catch (err) {
    // Connected, but PayPal wouldn't give the shop's sales: its refunds stay notice-only, and the page says why.
    const refusal = refusalText(err);
    await recordConnectRefusal(db, { shopId: input.shopId, refusal: `Connected, but the shop's sales couldn't be read. ${refusal}` });
    return { state: "CONNECTED", sales: { refusal } };
  }
}

/**
 * PayPal's webhook said a seller took its consent back. A webhook's body is covered only by a CRC, so this acts only on
 * PayPal's own status, read again: a link is forgotten once PayPal no longer shows it connected. If PayPal can't be read,
 * this throws, the delivery fails and PayPal sends it again, and the link stays.
 */
export async function confirmRevoked(db: Db, platform: PlatformEnv, input: { merchantId: string; recordKey: RecordKey }): Promise<{ forgotten: number; kept: number }> {
  let forgotten = 0;
  let kept = 0;
  for (const shop of await shopsLinkedTo(db, input.recordKey("paypal-merchant", input.merchantId))) {
    const status = await readSellerStatus(platform.client, { partnerId: platform.partnerId, trackingId: shop.trackingId, platformClientId: platform.clientId });
    if (status && status.merchantId === input.merchantId && isConnected(status)) {
      kept += 1;
      continue;
    }
    await disconnectShop(db, shop.shopId);
    forgotten += 1;
  }
  return { forgotten, kept };
}
