import type { Queryable } from "../db/types";
import { centsToValue } from "./orders";
import { PAST_WINDOW_SAMPLE } from "./payouts";

export interface SentRow {
  id: string;
  kind: "Refund" | "Payout";
  date: string;
  item: string;
  recallNumber: string;
  amount: string;
  currency: string;
  paypalStatus: string;
  paypalId: string;
  href: string;
}

/** The call log removes entire ids with :id. Here the ends help an owner compare two records. */
export function maskedPayPalId(id: string | null): string {
  if (!id) return "Not held here";
  return id.length > 8 ? `${id.slice(0, 4)}...${id.slice(-4)}` : "[hidden]";
}

/** Reads existing records only. No PayPal call, receiver, email, buyer name, or capture id. */
export async function readSentLedger(db: Queryable, shopId: string): Promise<SentRow[]> {
  const { rows } = await db.query<{
    id: string; kind: "Refund" | "Payout"; created_at: Date; item: string | null; recall_number: string | null;
    amount_cents: number; currency: string; paypal_status: string | null; status: string;
    paypal_id: string | null; sample_key: string | null;
  }>(
    `select f.id, 'Refund' as kind, f.created_at, l.title as item, r.recall_number,
       f.amount_cents, f.currency, event.resource_status as paypal_status, f.status,
       refs.refund_id as paypal_id, null::text as sample_key
     from refunds f
     join order_lines l on l.id = f.order_line_id and l.shop_id = f.shop_id
     join approvals a on a.id = f.approval_id and a.shop_id = f.shop_id
     join recalls r on r.recall_id = a.recall_id
     left join paypal_refund_refs refs on refs.refund_row_id = f.id
     left join lateral (
       select e.resource_status from paypal_webhook_events e
       where e.resource_id_hmac = f.refund_ref_hmac and e.resource_status is not null
       order by e.received_at desc, e.event_id_hmac desc limit 1
     ) event on true
     where f.shop_id = $1 and f.status <> 'reserved'
       and f.failure is distinct from 'Never sent to PayPal.'
     union all
     select p.id, 'Payout', p.created_at, null::text, null::text, p.amount_cents, p.currency,
       p.paypal_status, p.status, refs.batch_id, p.sample_key
     from payouts p left join paypal_payout_refs refs on refs.payout_row_id = p.id
     where p.shop_id = $1 and p.status <> 'reviewed'
     order by created_at desc, kind, id`,
    [shopId],
  );
  return rows.map((r) => {
    const sample = r.kind === "Payout" && r.sample_key === PAST_WINDOW_SAMPLE.key;
    return {
      id: r.id, kind: r.kind, date: r.created_at.toISOString(),
      item: r.item ?? (sample ? `Demo sale: ${PAST_WINDOW_SAMPLE.title}` : "Item not held here"),
      recallNumber: r.recall_number ?? (sample ? PAST_WINDOW_SAMPLE.recallNumber : "Not held here"),
      amount: centsToValue(r.amount_cents), currency: r.currency,
      paypalStatus: r.paypal_status ?? `Not held here (our record: ${r.status})`,
      paypalId: maskedPayPalId(r.paypal_id),
      href: r.kind === "Refund" ? `/queue/refunds/${r.id}` : "/queue#past-window",
    };
  });
}

// Table and CSV use these same fields, in the same order. Ids have already been masked.
export const SENT_COLUMNS = ["Date recorded (UTC)", "Type", "Item", "Recall number", "Amount", "Currency", "PayPal status (last stored)", "PayPal id", "Details"];
export const sentCells = (row: SentRow): string[] => [row.date, row.kind, row.item, row.recallNumber, row.amount, row.currency, row.paypalStatus, row.paypalId, row.href];

function csvCell(value: string): string {
  // Quoting alone does not stop a spreadsheet from executing a shop's title as a formula.
  const text = /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
}

export function sentLedgerCsv(rows: SentRow[]): string {
  return [SENT_COLUMNS, ...rows.map(sentCells)].map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
