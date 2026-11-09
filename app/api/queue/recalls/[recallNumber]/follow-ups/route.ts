import { agentClientFromEnv, OWN_SHOP_CAP_MICROS } from "@/server/agent/claude";
import { adviseFollowUp, storedAdvice } from "@/server/agent/followUpAdvice";
import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { dropFollowUp, followUpsFor, saleIdsOnText, saveFollowUp } from "@/server/queue/followUps";
import { loadQueue } from "@/server/queue/queue";
import { businessDay } from "@/server/time/businessDay";
import { createRateLimiter } from "@/server/web/rateLimit";
import { currentSession, fromThisSite, refused } from "@/server/web/http";
import { activeFollowUps, addDays, checkFollowUpDate, type FollowUpDateCheck, placeFollowUps } from "@/app/queue/recalls/followUps";
import { timelineFor, type TimelineSale } from "@/app/queue/recalls/timeline";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ recallNumber: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2048;
const MAX_ATTEMPTS = 20;
const BODY_TIMEOUT_MS = 5000;
const SIGN_IN = "sign in as a shop first";
const CPSC_CHANGED = "CPSC changed this recall. Plan the follow-ups again.";
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
  TOO_FAR: "Pick a day within 30 days.",
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

/** A refusal that says what's saved now, so a page holding a reminder that no longer stands can drop it. */
async function outOfDate(status: number, error: string, shopId: string, sales: readonly TimelineSale[]): Promise<Response> {
  const confirmed = activeFollowUps(await followUpsFor(getDb(), shopId), sales);
  return Response.json({ error, confirmed }, { status, headers: { "cache-control": "no-store" } });
}

const saleIdOf = (body: Record<string, unknown> | null) => (typeof body?.saleId === "string" && UUID.test(body.saleId) ? body.saleId : null);
const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_ATTEMPTS && value.every(isId);

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
    let advice = await storedAdvice(getDb(), recallNumber);
    if (!advice) {
      const client = agentClientFromEnv();
      if (!client) return refused(503, ADVICE_REFUSED.UNAVAILABLE[1]);
      if (!perShop(session.shopId)) return refused(429, "Too many plans. Try again in a while.");
      const result = await adviseFollowUp(getDb(), client, { recallNumber, now: new Date(), capMicros: OWN_SHOP_CAP_MICROS });
      if (result.status !== "ADVISED") {
        const [status, why] = ADVICE_REFUSED[result.status];
        return refused(status, why);
      }
      advice = result.advice;
    }
    const saved = await followUpsFor(getDb(), session.shopId);
    const done = new Set(saved.map((f) => f.matchId));
    const onThisText = await saleIdsOnText(getDb(), session.shopId, advice.snapshot);
    const open = timeline.sales.filter((s) => s.needsReaching && !done.has(s.id));
    const { proposals, closingSoon } = placeFollowUps(open.filter((s) => onThisText.has(s.id)), advice.withinDays, timeline.today);
    const notOnThisText = open.filter((s) => !onThisText.has(s.id)).length;
    // What's saved goes back too: this page may have missed a save, from a lost answer or another tab.
    return Response.json({ reason: advice.reason, hazardQuote: advice.hazardQuote, withinDays: advice.withinDays, snapshot: advice.snapshot, proposals, closingSoon, notOnThisText, confirmed: activeFollowUps(saved, timeline.sales) }, { headers: { "cache-control": "no-store" } });
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
  const snapshot = typeof body?.snapshot === "string" && body.snapshot.length > 0 && body.snapshot.length <= 128 ? body.snapshot : null;
  if (!snapshot) return refused(400, "not a follow-up");
  const attempt = body?.attempt;
  if (!isId(attempt)) return refused(400, "not a follow-up");
  const supersedes = body?.supersedes ?? [];
  if (!isIds(supersedes)) return refused(400, "not a follow-up");
  const due = typeof body?.due === "string" ? body.due : "";
  try {
    const timeline = await timelineOf(session.shopId, session.sessionId, recallNumber);
    const sale = timeline?.sales.find((s) => s.id === saleId);
    if (!timeline || !sale) return outOfDate(404, "This shop has no such sale of that recall.", session.shopId, timeline?.sales ?? []);
    if (!sale.needsReaching) return outOfDate(409, "This family has been reached or answered, so it needs no follow-up.", session.shopId, timeline.sales);
    const checked = checkFollowUpDate(sale, due, timeline.today);
    if (checked !== "OK") return refused(422, DATE_REFUSED[checked]);
    const advice = await storedAdvice(getDb(), recallNumber);
    if (!advice) return outOfDate(409, "Plan the follow-ups first.", session.shopId, timeline.sales);
    if (advice.snapshot !== snapshot) return outOfDate(409, CPSC_CHANGED, session.shopId, timeline.sales);
    if (due > addDays(timeline.today, advice.mostDays)) return refused(422, `Pick a day within ${advice.mostDays} days, given this hazard.`);
    const placed = placeFollowUps([sale], advice.withinDays, timeline.today).proposals[0];
    const movedEarlier = placed?.due === due && placed.movedEarlier;
    const saved = await saveFollowUp(getDb(), { shopId: session.shopId, matchId: saleId, due, reason: advice.reason, hazardQuote: advice.hazardQuote, movedEarlier, snapshot, attempt, supersedes });
    if (saved === "cancelled") return outOfDate(409, "This change was cancelled before it saved.", session.shopId, timeline.sales);
    // The sale was just found on this shop's timeline, so a refusal here means CPSC changed the recall a moment ago.
    if (!saved) return outOfDate(409, CPSC_CHANGED, session.shopId, timeline.sales);
    return Response.json({ saved: true, movedEarlier }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failed("save", err);
  }
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, SIGN_IN);
  const body = await readJson(request);
  const saleId = saleIdOf(body);
  if (!saleId) return refused(400, "not a follow-up");
  const attempt = body?.attempt;
  const supersedes = body?.supersedes ?? [];
  if (!isId(attempt) || !isIds(supersedes)) return refused(400, "not a follow-up");
  try {
    const dropped = await dropFollowUp(getDb(), session.shopId, saleId, { attempt, supersedes });
    if (dropped === "cancelled") {
      // A newer change to this reminder landed first. Hand back what's saved, so the page shows it.
      const timeline = await timelineOf(session.shopId, session.sessionId, (await params).recallNumber);
      return outOfDate(409, "This change was cancelled before it saved.", session.shopId, timeline?.sales ?? []);
    }
    return Response.json({ dismissed: true }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failed("dismiss", err);
  }
}
