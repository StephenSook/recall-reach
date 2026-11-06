import { notFound, redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { centsToValue } from "@/server/paypal/orders";
import { readRefund, RefundRefused, type Reconciliation } from "@/server/paypal/refunds";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { currentSession } from "@/server/web/http";

export const dynamic = "force-dynamic";

const money = (x: { amountCents: number; currency: string } | null) => (x ? `${centsToValue(x.amountCents)} ${x.currency}` : "not held here");

export default async function RefundPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) throw new Error("RECORD_HMAC_SECRET is not set");
  const { id } = await params;
  let rec: Reconciliation;
  try {
    rec = await readRefund(getDb(), payPalClientFromEnv(), { shopId: session.shopId, refundId: id, recordKey });
  } catch (err) {
    if (err instanceof RefundRefused) notFound();
    throw err;
  }
  return (
    <main className="page">
      <header className="page-head">
        <h1>Refund against PayPal</h1>
      </header>
      <div className="window" style={{ marginTop: 16 }}>
      <table className="ledger">
        <thead>
          <tr>
            <th>Record</th>
            <th>Status</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr data-testid="ledger">
            <td>Our ledger</td>
            <td>{rec.ledger.status}</td>
            <td>{money(rec.ledger)}</td>
          </tr>
          <tr data-testid="refund">
            <td>PayPal refund</td>
            <td>{rec.refund?.status ?? "not held here"}</td>
            <td>{money(rec.refund)}</td>
          </tr>
          <tr data-testid="capture">
            <td>PayPal payment</td>
            <td>{rec.capture?.status ?? "not held here"}</td>
            <td>{money(rec.capture)}</td>
          </tr>
          <tr data-testid="webhook">
            <td>PayPal webhook</td>
            <td>{rec.webhook.seen ? "received and verified" : "not yet"}</td>
            <td />
          </tr>
        </tbody>
      </table>
      </div>
      {rec.exceptions.length > 0 ? (
        <ul data-testid="exceptions" className="alert">
          {rec.exceptions.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : (
        <p data-testid="no-exceptions" className="alert">All four records agree.</p>
      )}
      {rec.newerAnswer ? (
        <form action="/api/queue/refunds/update" method="post" data-testid="newer-answer">
          <input type="hidden" name="refundId" value={id} />
          <button type="submit" className="btn">Update from PayPal</button>
        </form>
      ) : null}
      {rec.stuck ? (
        <section data-testid="stuck">
          <p>
            Check this payment in PayPal: order {rec.stuck.orderNumber}, {money(rec.ledger)}. If no refund shows, refund it there.
          </p>
          <form action="/api/queue/refunds/open-paypal" method="post">
            <input type="hidden" name="refundId" value={id} />
            <button type="submit" className="btn">Open PayPal</button>
          </form>
          {rec.stuck.sentToPayPal ? <p>Seller sent to PayPal</p> : null}
        </section>
      ) : null}
      {rec.canAskAgain ? (
        <form action="/api/queue/refunds/ask-again" method="post">
          <input type="hidden" name="refundId" value={id} />
          <p>This repeats the same request. If PayPal already made the refund, it answers with that refund and makes no second one. Don&apos;t use this if you refunded this sale in PayPal yourself.</p>
          <button type="submit" className="btn btn-outline">Ask PayPal again</button>
        </form>
      ) : null}
      <p>
        <a href="/queue">Back to the queue</a>
      </p>
    </main>
  );
}
