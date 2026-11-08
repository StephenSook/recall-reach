import type { Queryable } from "../db/types";
import { NoticeRefused } from "./store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noNotice = () => new NoticeRefused("NO_SUCH_NOTICE", "No door notice for this shop.");

// An approval cannot outlive its evidence, and a new print is new outreach: what went out before doesn't cover
// CPSC's new words. A door notice is a confirmed recall, never a question about whether a buyer's item might be included.
const FROM_NOTICE = `from notices n
  join recall_matches m on m.id = n.match_id and m.shop_id = n.shop_id
  join order_lines l on l.id = m.order_line_id and l.shop_id = n.shop_id
  join recalls r on r.recall_id = m.recall_id
  join shops s on s.id = n.shop_id`;
const ELIGIBLE = `n.id = $1 and n.shop_id = $2 and l.buyer_email_enc is null
  and n.kind = 'SAFETY_NOTICE' and m.verdict = 'MATCH' and m.strength = 'CONFIRMED'
  and m.join_state is distinct from 'AMBIGUOUS_JOIN'
  and m.recall_sha256 = r.raw_sha256`;

export interface DoorNotice {
  title: string;
  recallNumber: string;
  recallDate: string;
  hazards: string[];
  remedies: string[];
  consumerContact: string | null;
  recallUrl: string;
  firstSale: string | null;
  lastSale: string | null;
  demo: boolean;
  printedAt: string | null;
  /** Which of CPSC's words this is. A print names it, so what's recorded is what was on screen. */
  version: string;
}

/** Only public recall words and dates of confirmed sales. No buyer field leaves this query. */
export async function readDoorNotice(db: Queryable, input: { shopId: string; noticeId: string }): Promise<DoorNotice> {
  if (!UUID.test(input.noticeId)) throw noNotice();
  const { rows } = await db.query<{
    title: string; recall_number: string; recall_date: string; hazards: string[]; remedies: string[];
    consumer_contact: string | null; url: string; first_sale: string | null; last_sale: string | null;
    kind: string; printed_at: Date | null; version: string;
  }>(
    `select r.title, r.recall_number, r.recall_date::text, r.hazards, r.remedies, r.url, s.kind, r.raw_sha256 as version,
      case when jsonb_typeof(r.raw->'ConsumerContact') = 'string' then r.raw->>'ConsumerContact' end as consumer_contact,
      dates.first_sale, dates.last_sale,
      (select max(p.printed_at) from notice_door_prints p where p.notice_id = n.id and p.shop_id = n.shop_id) as printed_at
     ${FROM_NOTICE}
     cross join lateral (
       select min(ol.ordered_on)::text as first_sale, max(ol.ordered_on)::text as last_sale
       from order_lines ol where ol.shop_id = n.shop_id and exists (
         select 1 from recall_matches other where other.shop_id = n.shop_id and other.order_line_id = ol.id
         and other.recall_id = m.recall_id and other.verdict = 'MATCH' and other.strength = 'CONFIRMED'
         and other.recall_sha256 = r.raw_sha256 and other.join_state is distinct from 'AMBIGUOUS_JOIN'
       )
     ) dates
     where ${ELIGIBLE}`,
    [input.noticeId, input.shopId],
  );
  const r = rows[0];
  if (!r) throw noNotice();
  return {
    title: r.title, recallNumber: r.recall_number, recallDate: r.recall_date,
    hazards: r.hazards, remedies: r.remedies, consumerContact: r.consumer_contact,
    recallUrl: r.url, firstSale: r.first_sale, lastSale: r.last_sale, demo: r.kind === "DEMO",
    printedAt: r.printed_at?.toISOString() ?? null, version: r.version,
  };
}

/** One row for one button press, even if its request is retried. The existing session identifies the owner. */
export async function recordDoorPrint(db: Queryable, input: { shopId: string; sessionId: string; noticeId: string; actionId: string; version: string }): Promise<string> {
  if (!UUID.test(input.noticeId)) throw noNotice();
  if (!UUID.test(input.actionId)) throw new NoticeRefused("NO_ANSWER", "A print action needs a valid action id.");
  await db.query(
    `insert into notice_door_prints (notice_id, shop_id, action_id, session_id)
     select n.id, n.shop_id, $3::uuid, $4 ${FROM_NOTICE} where ${ELIGIBLE} and r.raw_sha256 = $5
     on conflict (notice_id, action_id) do nothing`,
    [input.noticeId, input.shopId, input.actionId, input.sessionId, input.version],
  );
  // Asked again for a retry: an action recorded before the evidence changed doesn't cover this print.
  const { rows } = await db.query<{ printed_at: Date }>(
    `select p.printed_at ${FROM_NOTICE}
     join notice_door_prints p on p.notice_id = n.id and p.shop_id = n.shop_id and p.action_id = $3::uuid and p.session_id = $4
     where ${ELIGIBLE} and r.raw_sha256 = $5`,
    [input.noticeId, input.shopId, input.actionId, input.sessionId, input.version],
  );
  if (!rows[0]) throw noNotice();
  return rows[0].printed_at.toISOString();
}
