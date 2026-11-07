import { notFound, redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { readCalls, withCallLog } from "@/server/paypal/callLog";
import { payPalClientFromEnv, PayPalApiError } from "@/server/paypal/client";
import { centsToValue } from "@/server/paypal/orders";
import { readRefund, RefundRefused, type Reconciliation } from "@/server/paypal/refunds";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { currentSession } from "@/server/web/http";
import { LookAgain } from "../../LookAgain";
import { PayPalCalls } from "../../PayPalCalls";

export const dynamic = "force-dynamic";

const money = (x: { amountCents: number; currency: string } | null) => (x ? `${centsToValue(x.amountCents)} ${x.currency}` : "not held here");

function Records({ rec, id }: { rec: Reconciliation; id: string }) {
  return (
    <>
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
          {rec.stuck.disputed ? (
            <p>Check this payment in PayPal: order {rec.stuck.orderNumber}, {money(rec.ledger)}. It has a dispute, and PayPal may already have paid the buyer, so settle the dispute there and don&apos;t refund it by hand.</p>
          ) : (
            <p>
              Check this payment in PayPal: order {rec.stuck.orderNumber}, {money(rec.ledger)}. If no refund shows, refund it there.
            </p>
          )}
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
    </>
  );
}

export default async function RefundPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) throw new Error("RECORD_HMAC_SECRET is not set");
  const { id } = await params;
  // Outside the try: a missing setting isn't a passing failure, and shouldn't read as one.
  const db = getDb();
  const client = payPalClientFromEnv();
  let rec: Reconciliation | null = null;
  try {
    rec = await withCallLog(db, session.shopId, () => readRefund(db, client, { shopId: session.shopId, refundId: id, recordKey }));
  } catch (err) {
    if (err instanceof RefundRefused) notFound();
    // A passing failure shouldn't take the page away from someone, least of all when the page looked again by itself.
    console.error("refund page could not read its records:", err instanceof PayPalApiError ? err.message : err instanceof Error ? err.name : "unknown error");
  }
  const calls = await readCalls(db, session.shopId).catch(() => []);
  // One page whichever happened, so LookAgain stays mounted and its time limit holds.
  const looking = !rec || (!rec.webhook.seen && rec.ledger.status !== "failed");
  return (
    <main className="page">
      <header className="page-head">
        <h1>Refund, checked against PayPal</h1>
      </header>
      {rec ? (
        <Records rec={rec} id={id} />
      ) : (
        <p role="alert" className="alert" data-testid="read-failed">
          The records can&apos;t be read just now, so they can&apos;t be compared yet. This page will look again.
        </p>
      )}
      {/* Each look reads PayPal again, so this one asks less often than the queue. */}
      {looking ? <LookAgain everyMs={5_000} forMs={180_000} /> : null}
      <p>
        <a href={rec?.matchId ? `/queue#sale-${rec.matchId}` : "/queue"}>Back to the queue</a>
      </p>
      <PayPalCalls calls={calls} />
    </main>
  );
}
