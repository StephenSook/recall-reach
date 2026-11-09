import { z } from "zod";
import type { TextCheckAnswer } from "@/server/match/textCheck";

export const PAYPAL_OPENED = "PayPal's page is open for the buyer to review and approve.";
export const PAYPAL_OPENING = "PayPal's page is opening in this tab for the buyer to review and approve.";
/** Where the client exposes the tools API. Browsers and desktop clients don't all agree yet. */
export type ToolSurface = "document" | "navigator";
export interface AgentCall { id: number; name: string; input: string; result: string; via: ToolSurface }
export interface ShopperTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint?: boolean; consequentialHint?: boolean };
  execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
}
interface ModelContext { registerTool: (tool: ShopperTool, options: { signal: AbortSignal }) => Promise<void> }
interface CheckoutWindow { location: { replace: (url: string) => void }; close: () => void; opener: unknown }
interface Deps { fetch: typeof fetch; open: () => CheckoutWindow | null; navigate: (url: string) => void; later: (run: () => void, ms: number) => void; onCall: (call: AgentCall) => void }
type Hosts = Record<ToolSurface, { modelContext?: ModelContext }>;

// Long enough for the assistant to get its answer before this page goes away.
const SAME_TAB_DELAY_MS = 1500;
// If this tab is still here that long after the move (the buyer stopped it, or came back), checkout is free again.
const STILL_HERE_MS = 10_000;

const searchInput = z.strictObject({ query: z.string().trim().min(2).max(200), maxPrice: z.number().finite().min(1).max(2000).optional() });
const checkInput = z.strictObject({ title: z.string().trim().min(2).max(200), model: z.string().trim().max(60).optional() });
const checkoutInput = z.strictObject({ listingId: z.string().min(1).max(64) });
const recall = z.object({ recallNumber: z.string(), title: z.string() });
const offer = z.object({ id: z.string(), title: z.string(), price: z.number(), retailer: z.string().nullable(), slipId: z.string() });
const blocked = z.object({ id: z.string(), title: z.string(), recallNumber: z.string().nullable(), recallTitle: z.string().nullable(), why: z.string() });
const searchAnswer = z.object({ offerable: z.array(offer).max(20), refused: z.array(blocked) });
const checkAnswer: z.ZodType<TextCheckAnswer> = z.object({
  results: z.array(recall.extend({
    recallDate: z.string(), url: z.string().nullable(), verdict: z.enum(["MATCH", "SCOPE_GAP"]),
    strength: z.enum(["CONFIRMED", "BRAND", "PRODUCT_WORDS", "NO_SHARED_WORDS"]),
    tiedToRecall: z.boolean(), sharesWords: z.boolean(), reason: z.string(), missing: z.array(z.string()), modelNamed: z.string().nullable().optional(),
  })),
  checked: z.object({ recalls: z.number(), from: z.string().nullable(), to: z.string().nullable(), yearsMissing: z.array(z.number()) }),
  mentioned: z.object({ recalls: z.array(recall), total: z.number() }),
  more: z.number(), cleared: z.number(), notJudged: z.number(), heldByMaker: z.number().optional(), note: z.string(),
});
const refusalAnswer = z.object({ recalls: z.array(recall) });
const refused = (recalls: z.infer<typeof recall>[] = [], error = "That listing wasn't offered on this page. Search again.") => ({ refused: true, error, recalls });

/** The document API first, then navigator's. Every client that has either gets the same tools. */
function findModelContext(hosts: Hosts): { context: ModelContext; via: ToolSurface } | null {
  for (const via of ["document", "navigator"] as const) {
    const context = hosts[via].modelContext;
    if (context && typeof context.registerTool === "function") return { context, via };
  }
  return null;
}

/** The browser is transport; provider responses never become tool results or log entries. */
export function registerShopperTools(hosts: Hosts, deps: Deps): () => void {
  const found = findModelContext(hosts);
  if (!found) return () => {};
  const { context, via } = found;
  const lifetime = new AbortController();
  const offers = new Map<string, z.infer<typeof offer>>();
  const refusals = new Map<string, z.infer<typeof recall>[]>();
  let nextCall = 0;
  let nextSearch = 0;
  let checkingOut = false;

  function tool<T>(name: string, description: string, schema: z.ZodType<T>, inputSchema: Record<string, unknown>, execute: (input: T, signal: AbortSignal) => Promise<{ value: unknown; summary: string }>): ShopperTool {
    return {
      name, description, inputSchema,
      annotations: { readOnlyHint: name !== "start_checkout", untrustedContentHint: name !== "start_checkout", consequentialHint: name === "start_checkout" },
      async execute(raw, options) {
        const input = schema.safeParse(raw);
        const call: AgentCall = { id: ++nextCall, name, input: input.success ? JSON.stringify(input.data).slice(0, 240) : "Invalid input", result: "Running", via };
        deps.onCall(call);
        let value: unknown;
        let summary: string;
        try {
          const signal = AbortSignal.any([lifetime.signal, options.signal]);
          signal.throwIfAborted();
          if (!input.success) {
            value = refused([], "Use only the fields and limits in this tool's schema.");
            summary = "Refused: invalid input";
          } else {
            ({ value, summary } = await execute(input.data, signal));
          }
        } catch {
          value = refused([], "The tool could not finish. Try again.");
          summary = "Refused: could not finish";
        }
        if (!lifetime.signal.aborted) deps.onCall({ ...call, result: summary });
        return value;
      },
    };
  }
  const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
  const tools = [
    tool("search_listings", "Search public store listings and offer only those with no recall match. A result does not establish safety.", searchInput,
      object({ query: { type: "string", minLength: 2, maxLength: 200 }, maxPrice: { type: "number", minimum: 1, maximum: 2000, description: "Maximum listing price in USD.", default: 2000 } }, ["query"]),
      async (input, signal) => {
        const generation = ++nextSearch;
        const params = new URLSearchParams({ query: input.query, maxPrice: String(input.maxPrice ?? 2000) });
        const res = await deps.fetch(`/api/shopper/listings?${params}`, { signal, cache: "no-store" });
        if (!res.ok) return { value: refused([], res.status === 429 ? "Too many searches. Try again in an hour." : "The search could not finish."), summary: "Refused: search unavailable" };
        const answer = searchAnswer.parse(await res.json());
        signal.throwIfAborted();
        if (generation !== nextSearch) return { value: refused([], "A newer search replaced this one."), summary: "Refused: search replaced" };
        offers.clear();
        refusals.clear();
        for (const item of answer.offerable) offers.set(item.id, item);
        for (const item of answer.refused) {
          const recalls = refusals.get(item.id) ?? [];
          if (item.recallNumber && item.recallTitle) recalls.push({ recallNumber: item.recallNumber, title: item.recallTitle });
          refusals.set(item.id, recalls);
        }
        const numbers = [...new Set(answer.refused.flatMap((r) => r.recallNumber ? [r.recallNumber] : []))];
        return {
          value: { offerable: answer.offerable.map((item) => ({ id: item.id, title: item.title, price: item.price, retailer: item.retailer })), refused: answer.refused.map((item) => ({ title: item.title, recallNumber: item.recallNumber, recallTitle: item.recallTitle, why: item.why })) },
          summary: `${answer.offerable.length} offered; ${answer.refused.length} refused${numbers.length ? ` under recall ${numbers.join(", ")}` : ""}`,
        };
      }),
    tool("check_recall", "Check a product's words against public CPSC recalls. Read any matching recall; this is not a safety finding.", checkInput,
      object({ title: { type: "string", minLength: 2, maxLength: 200 }, model: { type: "string", maxLength: 60 } }, ["title"]),
      async (input, signal) => {
        const params = new URLSearchParams({ title: input.title, model: input.model ?? "" });
        const res = await deps.fetch(`/api/check?${params}`, { signal, cache: "no-store" });
        if (!res.ok) return { value: refused([], "The recall check could not finish."), summary: "Refused: check unavailable" };
        const answer = checkAnswer.parse(await res.json());
        signal.throwIfAborted();
        const numbers = [...new Set([...answer.results, ...answer.mentioned.recalls].map((r) => r.recallNumber))];
        const incomplete = answer.notJudged > 0 || answer.more > 0 || answer.checked.yearsMissing.length > 0;
        return { value: answer, summary: `${incomplete ? "Check incomplete. " : ""}${numbers.length ? `Read CPSC recall ${numbers.join(", ")}` : "No recall match found"}` };
      }),
    tool("start_checkout", "Open an offered listing on PayPal's page for the buyer to review and approve. The assistant cannot approve payment.", checkoutInput,
      object({ listingId: { type: "string", minLength: 1, maxLength: 64 } }, ["listingId"]),
      async (input, signal) => {
        const item = offers.get(input.listingId);
        if (!item || checkingOut) {
          const recalls = refusals.get(input.listingId) ?? [];
          return { value: refused(recalls), summary: recalls.length ? `Refused under recall ${recalls.map((r) => r.recallNumber).join(", ")}` : "Refused: listing not available" };
        }
        // A tool call has no click behind it, so a browser may block this. Then this same tab goes to PayPal instead.
        const popup = deps.open();
        checkingOut = true;
        offers.delete(input.listingId);
        let opened = false;
        let leaving = false;
        try {
          if (popup) popup.opener = null;
          const res = await deps.fetch("/api/shopper/buy", { method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams({ slip: item.slipId }), signal });
          signal.throwIfAborted();
          if (!res.ok) {
            const answer = refusalAnswer.safeParse(await res.json());
            const recalls = answer.success ? answer.data.recalls : [];
            return { value: refused(recalls, "Checkout could not start. Search again or read the CPSC recall."), summary: recalls.length ? `Refused under recall ${recalls.map((r) => r.recallNumber).join(", ")}` : "Refused: checkout unavailable" };
          }
          // Read only the browser's redirect field. Never spread, return, or log the provider's response.
          const { approveUrl } = z.object({ approveUrl: z.string().url() }).parse(await res.json());
          const url = new URL(approveUrl);
          if (url.protocol !== "https:" || url.hostname !== "www.sandbox.paypal.com" || url.username || url.password || url.port || url.pathname !== "/checkoutnow") throw new Error("invalid approval destination");
          signal.throwIfAborted();
          if (popup) {
            popup.location.replace(approveUrl);
            opened = true;
            return { value: PAYPAL_OPENED, summary: "PayPal opened" };
          }
          leaving = true;
          const searchWhenAnswered = nextSearch;
          deps.later(() => {
            // Cancelled, this page's tools removed, or a newer search that may refuse this listing: stay put.
            if (signal.aborted || nextSearch !== searchWhenAnswered) {
              checkingOut = false;
              return;
            }
            deps.navigate(approveUrl);
            deps.later(() => { checkingOut = false; }, STILL_HERE_MS);
          }, SAME_TAB_DELAY_MS);
          return { value: PAYPAL_OPENING, summary: "PayPal opening in this tab" };
        } finally {
          // A tab about to leave for PayPal takes no second checkout.
          if (!leaving) checkingOut = false;
          if (popup && !opened) popup.close();
        }
      }),
  ];
  for (const definition of tools) {
    try {
      void Promise.resolve(context.registerTool(definition, { signal: lifetime.signal })).catch(() => lifetime.abort());
    } catch {
      lifetime.abort();
      break;
    }
  }
  return () => lifetime.abort();
}
