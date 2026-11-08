// Shop billing only. The shared webhook handler imports only BILLING_EVENTS to route verified billing events.
// Recall checks, notices, receipts, refunds and jobs never call this module.
import type { Db, Queryable } from "../db/types";
import type { PayPalClient } from "../paypal/client";
import { callsBelongTo } from "../paypal/callLog";
import { cancelSubscription, createSubscription, ensurePlan, readSubscription, subscriptionCustomId, type Subscription, type SubscriptionStatus } from "../paypal/subscriptions";
import { createContactCipher } from "../privacy/contactCipher";
import type { RecordKey } from "../privacy/recordKey";
import { PAYPAL_PURGE_CUTOFF_HOURS } from "../privacy/retention";

export class SubscriptionRefused extends Error {}
const REQUEST_ID_WINDOW_MS = 6 * 3_600_000;
const refuse = (message: string): never => { throw new SubscriptionRefused(message); };
export interface ShopSubscription { status: SubscriptionStatus | null; startedAt: string | null; recorded: boolean; closed: boolean; needsId: boolean }
interface Row { request_id: string; create_started_at: Date | null; subscription_id_hmac: string | null; plan_id: string; status: SubscriptionStatus | null; closed: boolean }
interface Input { shopId: string; recordKey: RecordKey; secret: string }

export async function requireRealShop(db: Queryable, shopId: string): Promise<void> {
  const { rows } = await db.query<{ kind: string }>("select kind from shops where id = $1", [shopId]);
  if (rows[0]?.kind !== "REAL") refuse("Subscriptions are for real shops only.");
}

export async function readShopSubscription(db: Queryable, shopId: string): Promise<ShopSubscription | null> {
  const { rows } = await db.query<{ status: SubscriptionStatus | null; started_at: Date | null; recorded: boolean; closed: boolean; needs_id: boolean }>(
    `select case when s.updated_at > now() - make_interval(hours => $2) then s.status end as status,
       case when s.updated_at > now() - make_interval(hours => $2) then s.started_at end as started_at,
       s.subscription_id_hmac is not null as recorded, s.closed,
       not exists (select 1 from paypal_subscription_refs r where r.shop_id = s.shop_id and r.received_at > now() - make_interval(hours => $2)) as needs_id
     from shop_subscriptions s where s.shop_id = $1`, [shopId, PAYPAL_PURGE_CUTOFF_HOURS],
  );
  const r = rows[0];
  return r ? { status: r.status, startedAt: r.started_at ? new Date(r.started_at).toISOString() : null, recorded: r.recorded, closed: r.closed, needsId: r.needs_id } : null;
}

async function locked<T>(db: Db, shopId: string, run: (tx: Queryable, row: Row) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const lock = await tx.query<{ locked: boolean }>("select pg_try_advisory_xact_lock(hashtext('shop-subscription'), hashtext($1)) as locked", [shopId]);
    if (!lock.rows[0]?.locked) refuse("A subscription change is already running. Try again shortly.");
    await requireRealShop(tx, shopId);
    const { rows } = await tx.query<Row>("select * from shop_subscriptions where shop_id = $1 for update", [shopId]);
    if (!rows[0]) refuse("Start this shop's subscription first.");
    return run(tx, rows[0]);
  });
}

async function savedId(db: Queryable, input: Input, typedId?: string): Promise<string> {
  if (typedId) return typedId;
  const { rows } = await db.query<{ subscription_id_sealed: string }>(
    "select subscription_id_sealed from paypal_subscription_refs where shop_id = $1 and received_at > now() - make_interval(hours => $2)", [input.shopId, PAYPAL_PURGE_CUTOFF_HOURS],
  );
  if (!rows[0]) refuse("Enter the subscription id from your PayPal sandbox account to cancel. Its raw id is no longer kept here.");
  return createContactCipher(input.secret, input.shopId).open(rows[0].subscription_id_sealed);
}

function confirm(input: Input, row: Row, sub: Subscription): void {
  if (sub.customId !== subscriptionCustomId(input.recordKey, input.shopId) || sub.planId !== row.plan_id ||
    (row.subscription_id_hmac && row.subscription_id_hmac !== input.recordKey("paypal-resource", sub.id))) refuse("That subscription does not belong to this shop and plan.");
}

async function save(db: Queryable, input: Input, sub: Pick<Subscription, "id" | "status" | "startTime">): Promise<void> {
  await db.query(
    `update shop_subscriptions set subscription_id_hmac = $2, status = $3, started_at = $4,
       closed = closed or $3 in ('CANCELLED', 'EXPIRED'), updated_at = now()
     where shop_id = $1 and (not closed or $3 in ('CANCELLED', 'EXPIRED'))`,
    [input.shopId, input.recordKey("paypal-resource", sub.id), sub.status, sub.status === "ACTIVE" ? sub.startTime : null],
  );
}

export async function startShopSubscription(db: Db, client: PayPalClient, input: Input & { planId: string; site: string }): Promise<string | null> {
  await requireRealShop(db, input.shopId);
  // Committed before calling PayPal. A crash or a lost reply must reuse this exact request id, including across processes.
  await db.query("insert into shop_subscriptions (shop_id, plan_id) values ($1, $2) on conflict (shop_id) do nothing", [input.shopId, input.planId]);
  // Commit the create window before the POST's transaction, so a lost reply or rollback cannot reset it.
  // Both transactions use the same per-shop try-lock; neither can create alongside another billing change.
  await locked(db, input.shopId, async (tx, row) => {
    if (row.closed || row.subscription_id_hmac) return;
    if (row.create_started_at && row.plan_id !== input.planId) refuse("This subscription attempt's stored plan differs from the configured plan. Check your PayPal sandbox account.");
    await ensurePlan(client, input.planId);
    if (!row.create_started_at) await tx.query(
      "update shop_subscriptions set plan_id = $2, create_started_at = $3 where shop_id = $1",
      [input.shopId, input.planId, new Date(Date.now())],
    );
  });
  return locked(db, input.shopId, async (tx, row) => {
    if (row.closed) refuse("This shop's subscription is cancelled or expired.");
    if (row.subscription_id_hmac) {
      const sub = await readSubscription(client, await savedId(tx, input));
      confirm(input, row, sub);
      await save(tx, input, sub);
      return sub.status === "APPROVAL_PENDING" ? sub.approveUrl : null;
    }
    if (row.plan_id !== input.planId) refuse("This subscription attempt's stored plan differs from the configured plan. Check your PayPal sandbox account.");
    // PayPal's request-id retention is finite. Check after the plan read, immediately before creating.
    if (!row.create_started_at) return refuse("This subscription attempt needs checking in PayPal before another can start.");
    const notAfter = new Date(row.create_started_at).getTime() + REQUEST_ID_WINDOW_MS;
    if (Date.now() > notAfter) refuse("This subscription attempt needs checking in PayPal before another can start.");
    const sub = await createSubscription(client, { ...input, planId: row.plan_id, requestId: row.request_id, notAfter });
    if (!sub.approveUrl && sub.status === "APPROVAL_PENDING") throw new Error("PayPal returned no subscription approval link");
    await save(tx, input, { ...sub, startTime: null });
    await tx.query("insert into paypal_subscription_refs (shop_id, subscription_id_sealed) values ($1, $2)", [input.shopId, createContactCipher(input.secret, input.shopId).seal(sub.id)]);
    return sub.approveUrl;
  });
}

export async function returnShopSubscription(db: Db, client: PayPalClient, input: Input & { subscriptionId: string }): Promise<SubscriptionStatus> {
  return locked(db, input.shopId, async (tx, row) => {
    if (!row.subscription_id_hmac || row.subscription_id_hmac !== input.recordKey("paypal-resource", input.subscriptionId)) refuse("That subscription was not started for this shop.");
    const sub = await readSubscription(client, input.subscriptionId);
    confirm(input, row, sub);
    if (row.closed && !["CANCELLED", "EXPIRED"].includes(sub.status)) refuse("This shop's subscription is already closed.");
    await save(tx, input, sub);
    return sub.status;
  });
}

export async function cancelShopSubscription(db: Db, client: PayPalClient, input: Input & { subscriptionId?: string }): Promise<{ status: SubscriptionStatus | null; closed: boolean; alreadyClosed: boolean }> {
  return locked(db, input.shopId, async (tx, row) => {
    if (row.closed) return { status: row.status, closed: true, alreadyClosed: true };
    const subscriptionId = await savedId(tx, input, input.subscriptionId);
    if (row.subscription_id_hmac !== input.recordKey("paypal-resource", subscriptionId)) refuse("That subscription does not belong to this shop.");
    let sub = await readSubscription(client, subscriptionId);
    confirm(input, row, sub);
    if (sub.status !== "CANCELLED" && sub.status !== "EXPIRED") {
      await cancelSubscription(client, subscriptionId, `c-${row.request_id}`);
      sub = await readSubscription(client, subscriptionId);
      confirm(input, row, sub);
    }
    await save(tx, input, sub);
    return { status: sub.status, closed: sub.status === "CANCELLED" || sub.status === "EXPIRED", alreadyClosed: false };
  });
}

export const BILLING_EVENTS = {
  "BILLING.SUBSCRIPTION.ACTIVATED": "ACTIVE",
  "BILLING.SUBSCRIPTION.CANCELLED": "CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED": "SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED": "EXPIRED",
} as const;

/** Verified events trigger a current read, not a replay of an old status. Unknown subscriptions cause no API call. */
export async function syncSubscriptionEvent(db: Db, client: PayPalClient, input: { recordKey: RecordKey; secret: string; subscriptionId: string }): Promise<void> {
  const { rows } = await db.query<{ shop_id: string; closed: boolean }>("select shop_id, closed from shop_subscriptions where subscription_id_hmac = $1", [input.recordKey("paypal-resource", input.subscriptionId)]);
  if (!rows[0] || rows[0].closed) return;
  callsBelongTo(rows[0].shop_id);
  await returnShopSubscription(db, client, { ...input, shopId: rows[0].shop_id });
}
