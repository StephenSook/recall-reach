import { getBillingDb } from "@/server/db/pg";
import { SHOP_PLAN, subscriptionPlanId } from "@/server/paypal/subscriptions";
import { readShopSubscription, type ShopSubscription as State } from "@/server/shop/subscription";
import { ranAt } from "@/app/replay/labels";

export const SUBSCRIPTION_READ_TIMEOUT_MS = 1500;

function subscriptionStatus(state: State): string {
  if (state.status === "CANCELLED") return "Cancelled.";
  if (state.status === "EXPIRED") return "Expired.";
  if (state.closed) return "Cancelled or expired.";
  switch (state.status) {
    case "ACTIVE": return `Active${state.startedAt ? ` since ${ranAt(state.startedAt)}` : ""}.`;
    case "SUSPENDED": return "Suspended.";
    case "APPROVAL_PENDING": return "Pending approval on PayPal.";
    case "APPROVED": return "Approved on PayPal, not active yet.";
    case null: return state.recorded ? "Subscription status is no longer held here." : "PayPal hasn't confirmed a subscription for this shop yet. Check subscription attempt asks PayPal again.";
    default: return `PayPal reports ${state.status}.`;
  }
}

export function SubscriptionPanel({ state, configured }: { state: State | null; configured: boolean }) {
  const cancel = state?.recorded && !state.closed && (state.status === "ACTIVE" || state.status === "SUSPENDED" || state.status === null);
  return (
    <section className="upload" aria-labelledby="shop-plan-title">
      <h2 id="shop-plan-title" className="section-title">{SHOP_PLAN.name}</h2>
      <p>PayPal sandbox, no real charge. Everything that keeps families safe stays free.</p>
      <p>Deleting the shop, including its automatic deletion after 7 days with no linked PayPal login or a year with no sign-in, does not cancel the subscription at PayPal, so cancel it first.</p>
      {!configured ? <p>Subscriptions are not set up: PAYPAL_SUBSCRIPTION_PLAN_ID is missing. Cancel an existing subscription in your PayPal sandbox account.</p> : <>
        {!state ? <>
          <p>Optional during the hackathon: support Recall Reach for {SHOP_PLAN.value} {SHOP_PLAN.currency} a month. Families never pay.</p>
          <form action="/api/shop/subscription/start" method="post"><button type="submit" className="btn btn-outline">Subscribe with PayPal</button></form>
        </> : <p>{subscriptionStatus(state)}</p>}
        {state && !state.recorded ? <form action="/api/shop/subscription/start" method="post"><button className="btn btn-outline" type="submit">Check subscription attempt</button></form> : null}
        {state?.status === "APPROVAL_PENDING" || state?.status === "APPROVED" ? <>
          <p>Finish or cancel this attempt in your PayPal sandbox account.</p>
          {state.status === "APPROVAL_PENDING" && !state.needsId ? <form action="/api/shop/subscription/start" method="post"><button className="btn btn-outline" type="submit">Continue on PayPal</button></form> : null}
        </> : null}
        {cancel ? <form action="/api/shop/subscription/cancel" method="post">
          {state.needsId ? <label>Subscription id from PayPal<input name="subscriptionId" required maxLength={80} /></label> : null}
          <button type="submit" className="btn btn-outline">Cancel</button>
        </form> : null}
      </>}
    </section>
  );
}

/** Rendered inside the queue's billing Suspense boundary. */
export async function ShopSubscriptionSection({ shopId }: { shopId: string }) {
  return shopSubscriptionPanel(shopId);
}

/** Billing failures and slow reads stay inside the panel. */
export async function shopSubscriptionPanel(shopId: string) {
  const configured = subscriptionPlanId() !== null;
  let state: State | null = null;
  let unavailable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A billing read must never prevent the queue or any safety action from loading.
  try {
    if (configured) state = await Promise.race([
      readShopSubscription(getBillingDb(), shopId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Subscription read timed out")), SUBSCRIPTION_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    unavailable = true;
  } finally {
    clearTimeout(timer);
  }
  return unavailable ? <section className="upload"><h2 className="section-title">{SHOP_PLAN.name}</h2><p>Subscription status is unavailable. Check your PayPal sandbox account.</p><p>PayPal sandbox, no real charge. Everything that keeps families safe stays free.</p></section> : <SubscriptionPanel configured={configured} state={state} />;
}
