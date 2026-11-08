import { redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { currentSession } from "@/server/web/http";
import { readSentLedger, SENT_COLUMNS, sentCells } from "@/server/paypal/sentLedger";

export const dynamic = "force-dynamic";

export default async function SentLedgerPage() {
  const session = await currentSession();
  if (!session) redirect("/?demo=noqueue");
  const rows = await readSentLedger(getDb(), session.shopId);
  return (
    <main className="page">
      <header className="page-head"><h1>Refunds sent</h1></header>
      <p>Refund and payout requests sent to PayPal, with the last status held here. Sandbox only.</p>
      <p><a className="btn btn-outline" href="/queue/sent/csv">Download CSV</a></p>
      {rows.length === 0 ? <p>No refunds or payouts sent yet.</p> : (
        <div className="calls-scroll" role="region" aria-label="Refunds and payouts sent" tabIndex={0}>
          <table className="ledger">
            <thead><tr>{SENT_COLUMNS.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={`${row.kind}:${row.id}`}>
                {sentCells(row).map((cell, i) => <td key={i}>{i === SENT_COLUMNS.length - 1 ? <a href={row.href}>Open {row.kind.toLowerCase()}</a> : cell}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </main>
  );
}
