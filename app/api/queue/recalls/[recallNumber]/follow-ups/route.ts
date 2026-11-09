import { agentClientFromEnv, OWN_SHOP_CAP_MICROS } from "@/server/agent/claude";
import { adviseFollowUp, storedAdvice } from "@/server/agent/followUpAdvice";
import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { dropFollowUp, followUpsFor, saveFollowUp } from "@/server/queue/followUps";
import { loadQueue } from "@/server/queue/queue";
import { businessDay } from "@/server/time/businessDay";
import { createRateLimiter } from "@/server/web/rateLimit";
import { currentSession, fromThisSite, refused } from "@/server/web/http";
import { checkFollowUpDate, type FollowUpDateCheck, placeFollowUps } from "@/app/queue/recalls/followUps";
import { timelineFor } from "@/app/queue/recalls/timeline";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ recallNumber: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 512;
const BODY_TIMEOUT_MS = 5000;
const SIGN_IN = "sign in as a shop first";
const perShop = createRateLimiter({ limit: 30, windowMs: 60 * 60 * 1000 });

const ADVICE_REFUSED = {
  NO_ADVICE: [502, "Claude couldn't back a date with CPSC's words, so no dates are proposed."],
  UNAVAILABLE: [503, "Claude isn't available right now. You can still work from the list."],
  OVER_BUDGET: [429, "Claude has reached today's limit. You can still work from the list."],
  NO_SUCH_RECALL: [404, "That recall isn't loaded."],
} as const;

const DATE_REFUSED: Record<Exclude<FollowUpDateCheck, "OK">, string> = {
  NOT_A_DATE: "Pick a day.",
  PAST: "That day has gone.",
  TOO_LATE: "That leaves less than a week of this sale's refund window.",
};

async function timelineOf(shopId: string, sessionId: string, recallNumber: string) {
  const { rows, shop } = await loadQueue(getDb(), shopId, sessionId);
  return shop ? timelineFor(rows, recallNumber, businessDay()) : null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const read = await readCappedBody(request, MAX_BODY_BYTES, { timeoutMs: BODY_TIMEOUT_MS });
  if (!read.ok) return null;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(read.body));
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const saleIdOf = (body: Record<string, unknown> | null) => (typeof body?.saleId === "string" && UUID.test(body.saleId) ? body.saleId : null);

const failed = (where: string, err: unknown) => {
  // The name only: a database error can quote what it was given.
  console.error(`follow-up ${where} failed:`, err instanceof Error ? err.name : "unknown error");
  return refused(503, "That didn't work. Please try again.");
};

// "Plan follow-ups with Claude". Claude is asked about the recall by its number. No sale reaches it: code sets each date.
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, SIGN_IN);
  const { recallNumber } = await params;
  try {
    const timeline = await timelineOf(session.shopId, session.sessionId, recallNumber);
    if (!timeline) return refused(404, "This shop has no sale of that recall.");
    const client = agentClientFromEnv();
    if (!client) return refused(503, ADVICE_REFUSED.UNAVAILABLE[1]);
    if (!perShop(session.shopId)) return refused(429, "Too many plans. Try again in a while.");
    const result = await adviseFollowUp(getDb(), client, { recallNumber, now: new Date(), capMicros: OWN_SHOP_CAP_MICROS });
    if (result.status !== "ADVISED") {
      const [status, why] = ADVICE_REFUSED[result.status];
      return refused(status, why);
    }
    const done = new Set((await followUpsFor(getDb(), session.shopId)).map((f) => f.matchId));
    const { proposals, closingSoon } = placeFollowUps(timeline.sales.filter((s) => !done.has(s.id)), result.advice.withinDays, timeline.today);
    return Response.json({ reason: result.advice.reason, hazardQuote: result.advice.hazardQuote, withinDays: result.advice.withinDays, proposals, closingSoon }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failed("plan", err);
  }
}

// Confirm, or move a confirmed one. The date is checked here against the shop's own sale, and the reason is read here too.
export async function PUT(request: Request, { params }: Context): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, SIGN_IN);
  const { recallNumber } = await params;
  const body = await readJson(request);
  const saleId = saleIdOf(body);
  if (!saleId) return refused(400, "not a follow-up");
  const due = typeof body?.due === "string" ? body.due : "";
  try {
    const timeline = await timelineOf(session.shopId, session.sessionId, recallNumber);
    const sale = timeline?.sales.find((s) => s.id === saleId);
    if (!timeline || !sale) return refused(404, "This shop has no such sale of that recall.");
    if (!sale.needsReaching) return refused(409, "This family has been reached or answered, so it needs no follow-up.");
    const checked = checkFollowUpDate(sale, due, timeline.today);
    if (checked !== "OK") return refused(422, DATE_REFUSED[checked]);
    const advice = await storedAdvice(getDb(), recallNumber);
    if (!advice) return refused(409, "Plan the follow-ups first.");
    const placed = placeFollowUps([sale], advice.withinDays, timeline.today).proposals[0];
    const saved = await saveFollowUp(getDb(), { shopId: session.shopId, matchId: saleId, due, reason: advice.reason, hazardQuote: advice.hazardQuote, movedEarlier: placed?.due === due && placed.movedEarlier });
    if (!saved) return refused(404, "This shop has no such sale of that recall.");
    return Response.json({ saved: true }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failed("save", err);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, SIGN_IN);
  const saleId = saleIdOf(await readJson(request));
  if (!saleId) return refused(400, "not a follow-up");
  try {
    await dropFollowUp(getDb(), session.shopId, saleId);
    return Response.json({ dismissed: true }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failed("dismiss", err);
  }
}
