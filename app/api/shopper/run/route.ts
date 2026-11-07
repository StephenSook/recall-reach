import { agentClientFromEnv } from "@/server/agent/claude";
import { MAX_ASK, runShopper, type ShopperRun } from "@/server/agent/shopper";
import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { checkListing } from "@/server/match/textCheck";
import { createSlip, SLIP_LASTS_MS } from "@/server/paypal/shopperOrder";
import { channel3Listings } from "@/server/sweep/channel3";
import { businessDay } from "@/server/time/businessDay";
import { fromThisSite, refused } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

const MAX_BODY = 2 * 1024;
const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const HOUR = 60 * 60_000;
// Each run is several real Claude calls, so it's limited per visitor and for everyone together.
const perVisitor = createRateLimiter({ limit: 5, windowMs: HOUR });
const everyone = createRateLimiter({ limit: 40, windowMs: HOUR });
const MAX_BUDGET = 2000;
// Spending is counted after each answer, so runs side by side could pass the day's limit together. This keeps that overshoot small.
const MAX_AT_ONCE = 3;
let running = 0;

export interface ShopperView {
  outcome: ShopperRun["outcome"] | "BUSY";
  steps: ShopperRun["steps"];
  blocked: { title: string; priceCents: number; recalls: { number: string; title: string; url: string | null }[] }[];
  pick: { slipId: string; title: string; brand: string | null; priceCents: number; recallsChecked: number; from: string | null; similar: number; minutes: number } | null;
}

const nothing = (outcome: ShopperView["outcome"]): ShopperView => ({ outcome, steps: [], blocked: [], pick: null });

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor) || !everyone("all")) return Response.json(nothing("BUSY"), { status: 429 });
  const read = await readCappedBody(request, MAX_BODY);
  if (!read.ok) return Response.json({ error: "request too large" }, { status: 413 });
  const body = parseJson(read.body) as { ask?: unknown; budget?: unknown } | null;
  const ask = typeof body?.ask === "string" ? body.ask.trim() : "";
  const budget = typeof body?.budget === "number" ? body.budget : Number.NaN;
  if (ask.length < 2 || ask.length > MAX_ASK || !Number.isFinite(budget) || budget < 1 || budget > MAX_BUDGET) return refused(400, "give what you're looking for and a budget from 1 to 2000");
  const client = agentClientFromEnv();
  if (!client) return Response.json(nothing("UNAVAILABLE"));
  if (running >= MAX_AT_ONCE) return Response.json(nothing("BUSY"), { status: 429 });
  const db = getDb();
  const now = new Date();
  running++;
  const run = await runShopper(db, client, { ask, budgetCents: Math.round(budget * 100), now }, {
    search: channel3Listings().search,
    check: (listing) => checkListing(db, listing, businessDay(now)),
  }).finally(() => {
    running--;
  });
  // The offer's ten minutes start when it's made, not when the agent began.
  const slip = run.pick ? await createSlip(db, run.pick.listing, new Date()) : null;
  const view: ShopperView = {
    outcome: run.outcome,
    steps: run.steps,
    blocked: run.blocked.map((b) => ({ title: b.listing.title, priceCents: b.listing.priceCents, recalls: b.recalls })),
    pick:
      run.pick && slip
        ? { slipId: slip.id, title: run.pick.listing.title, brand: run.pick.listing.brand, priceCents: run.pick.listing.priceCents, recallsChecked: run.pick.recallsChecked, from: run.pick.from, similar: run.pick.similar, minutes: SLIP_LASTS_MS / 60_000 }
        : null,
  };
  return Response.json(view);
}
