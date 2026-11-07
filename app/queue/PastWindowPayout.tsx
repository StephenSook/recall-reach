import { PAST_WINDOW_SAMPLE, type ShopPayout } from "@/server/paypal/payouts";
import { centsToValue } from "@/server/paypal/orders";

const ACTION = "/api/queue/payouts";
const ASKING: Record<Exclude<ShopPayout["status"], "reviewed">, string> = {
  unconfirmed: "Sent to PayPal. It hasn't confirmed this yet.",
  paid: "PayPal says this was paid.",
  unclaimed: "PayPal says nobody has claimed this yet.",
  failed: "PayPal says this didn't reach the buyer.",
};
const money = (cents: number, currency: string) => `${centsToValue(cents)} ${currency}`;

function ReviewForm({ amount, receiver }: { amount: string; receiver: string }) {
  return (
    <form action={ACTION} method="post">
      <input type="hidden" name="action" value="review" />
      <p>To the demo buyer&apos;s sandbox account: {receiver}</p>
      <label className="field">
        Amount in {PAST_WINDOW_SAMPLE.currency} <input name="amount" inputMode="decimal" defaultValue={amount} required />
      </label>
      <div className="actions">
        <button type="submit" className="btn btn-outline">
          Review this payment
        </button>
      </div>
    </form>
  );
}

/** Apart from the recall cards and every count: a labelled sample of a sale a refund can't reach. */
export function PastWindowPayout({ product, recalledOn, payout, receiver }: { product: string; recalledOn: string; payout: ShopPayout | null; receiver: string }) {
  const price = centsToValue(PAST_WINDOW_SAMPLE.priceCents);
  return (
    <details id="past-window" data-testid="past-window" className="window" style={{ marginTop: 16 }} open={payout !== null}>
      <summary>A sale past the refund window (sample)</summary>
      <p className="note">A labelled sample, not a sale, and not in any count.</p>
      <p>
        CPSC recall {PAST_WINDOW_SAMPLE.recallNumber}: {product}. Recalled {recalledOn}. Sold {PAST_WINDOW_SAMPLE.soldOn} for {price} {PAST_WINDOW_SAMPLE.currency}. PayPal&apos;s refund window closes after 180 days, so a refund can&apos;t reach this sale.
      </p>
      <p>You can choose to send a separate payment instead. It isn&apos;t a PayPal refund: it comes out of the shop&apos;s own PayPal balance, not the original payment. You approve one exact amount, twice. Here it&apos;s sandbox test money.</p>
      {!payout ? <ReviewForm amount={price} receiver={receiver} /> : null}
      {payout?.status === "reviewed" ? (
        <>
          <form action={ACTION} method="post" data-testid="payout-confirm">
            <input type="hidden" name="action" value="send" />
            <input type="hidden" name="payoutId" value={payout.id} />
            <input type="hidden" name="approvalId" value={payout.approvalId} />
            <p>
              Send {money(payout.amountCents, payout.currency)} from the shop&apos;s balance to {payout.receiver}?
            </p>
            <div className="actions">
              <button type="submit" className="btn">
                Send this payment
              </button>
            </div>
          </form>
          <details>
            <summary>Change it</summary>
            <ReviewForm amount={centsToValue(payout.amountCents)} receiver={receiver} />
          </details>
        </>
      ) : null}
      {payout && payout.status !== "reviewed" ? (
        <div data-testid="payout-state">
          <p>
            <strong>{ASKING[payout.status]}</strong> {money(payout.amountCents, payout.currency)} to {payout.receiver}.{payout.paypalStatus ? ` PayPal's status: ${payout.paypalStatus}.` : ""}
          </p>
          {payout.status === "failed" ? (
            <ReviewForm amount={centsToValue(payout.amountCents)} receiver={receiver} />
          ) : (
            <form action={ACTION} method="post">
              <input type="hidden" name="action" value="read" />
              <input type="hidden" name="payoutId" value={payout.id} />
              <button type="submit" className="btn btn-outline">
                Check it against PayPal
              </button>
            </form>
          )}
        </div>
      ) : null}
    </details>
  );
}
