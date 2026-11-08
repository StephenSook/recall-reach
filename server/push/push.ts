// The phone app's one job: buzz when a card lands. Apple, Google and Expo are third parties, so a push can carry only a
// public recall number and our own card id. It is built from those two values, so nothing else can reach the wire.
import type { Queryable } from "../db/types";
import { readCappedBody } from "../http/body";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;
const RECALL_NUMBER = /^[A-Za-z0-9-]{1,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKENS_PER_SHOP = 5;
/** A burst of new recalls is one glance at the queue, not a row of buzzes. */
const MAX_PUSHES = 3;
const SEND_TIMEOUT_MS = 5000;
/** Far more than a ticket per message needs. This runs on a webhook's path, so a long answer isn't read. */
const MAX_ANSWER_BYTES = 64_000;

export interface CardPush {
  recallNumber: string;
  /** The card to open. Only a match is sure to have its own card: anything else may sit under a stronger one, so it opens the queue. */
  matchId: string | null;
  kind: "sold" | "listed" | "receipt";
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: { path: string };
  sound: "default";
  priority: "high";
  channelId: "cards";
}

export function pushMessage(card: CardPush, token: string): PushMessage | null {
  if (!RECALL_NUMBER.test(card.recallNumber) || (card.matchId !== null && !UUID.test(card.matchId))) return null;
  const what = card.kind === "receipt" ? "a safety receipt" : card.kind === "listed" ? "something you listed" : "something you sold";
  return { to: token, title: "Recall Reach", body: `Recall ${card.recallNumber}: ${what} needs a look`, data: { path: card.matchId ? `/queue#sale-${card.matchId}` : "/queue" }, sound: "default", priority: "high", channelId: "cards" };
}

/** A phone follows the shop it's on now. The token is the table's key, so it's on one shop at a time, and moving it is one statement. */
export async function registerPushToken(db: Queryable, shopId: string, token: string): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  const { rows } = await db.query(
    "insert into push_tokens (token, shop_id) select $2, id from shops where id = $1 on conflict (token) do update set shop_id = excluded.shop_id, created_at = now() returning 1",
    [shopId, token],
  );
  if (rows.length === 0) return false;
  await db.query(
    "delete from push_tokens where shop_id = $1 and token not in (select token from push_tokens where shop_id = $1 order by created_at desc, token desc limit $2)",
    [shopId, MAX_TOKENS_PER_SHOP],
  );
  return true;
}

/**
 * Tells a shop's phones about cards that just landed: a brand or model, not a shared word. It never throws, because a
 * sale or a recall is already safely on the queue by now, and a push is only a nudge to go and look. Returns how many went.
 */
export async function pushNewCards(db: Queryable, shopId: string, matchIds: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  try {
    if (matchIds.length === 0) return 0;
    const { rows: phones } = await db.query<{ token: string }>("select token from push_tokens where shop_id = $1", [shopId]);
    if (phones.length === 0) return 0;
    const { rows: cards } = await db.query<{ id: string; recall_number: string; listed: boolean; receipt: boolean; matched: boolean }>(
      `select distinct on (r.recall_number) m.id, r.recall_number, m.shop_item_id is not null as listed, m.safety_receipt_id is not null as receipt, m.verdict = 'MATCH' as matched
       from recall_matches m join recalls r on r.recall_id = m.recall_id
       where m.shop_id = $1 and m.id = any($2::uuid[]) and m.verdict <> 'CLEARED' and m.strength in ('CONFIRMED', 'BRAND')
       order by r.recall_number desc, (m.strength = 'CONFIRMED') desc, (m.shop_item_id is null) desc
       limit $3`,
      [shopId, matchIds, MAX_PUSHES],
    );
    if (cards.length === 0) return 0;
    const messages = cards.flatMap((c) => phones.flatMap((p) => pushMessage({ recallNumber: c.recall_number, matchId: c.matched ? c.id : null, kind: c.receipt ? "receipt" : c.listed ? "listed" : "sold" }, p.token) ?? []));
    if (messages.length === 0) return 0;
    const res = await fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("push failed: Expo answered", res.status);
      return 0;
    }
    const answer = await readCappedBody(res, MAX_ANSWER_BYTES, { timeoutMs: SEND_TIMEOUT_MS });
    if (!answer.ok) {
      console.error("push failed: Expo's answer was too long or too slow");
      return 0;
    }
    const { data } = JSON.parse(new TextDecoder().decode(answer.body)) as { data?: { status?: string; details?: { error?: string } }[] };
    const tickets = Array.isArray(data) ? data : [];
    const gone = messages.filter((_, i) => tickets[i]?.details?.error === "DeviceNotRegistered").map((m) => m.to);
    if (gone.length > 0) await db.query("delete from push_tokens where shop_id = $1 and token = any($2::text[])", [shopId, gone]);
    return tickets.filter((t) => t.status === "ok").length;
  } catch (err) {
    // The name only: an error here could quote a phone's token.
    console.error("push failed:", err instanceof Error ? err.name : "unknown error");
    return 0;
  }
}
