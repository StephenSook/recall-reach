import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { registerShopperTools, PAYPAL_OPENED, type AgentCall, type ShopperTool } from "./webmcp";
import { AgentCallPanel } from "./AgentTools";
import type { TextCheckAnswer } from "@/server/match/textCheck";

const offer = { id: "tub", title: "Folding Tub", price: 24.99, retailer: "store.example", slipId: "private-slip" };
const refusal = { id: "clikk", title: "Stokke Clikk High Chair", recallNumber: "22113", recallTitle: "Stokke Recalls Clikk High Chairs Due to Fall and Injury Hazards", why: "Its words name a recall; read the CPSC notice." };
const secretUrl = "https://www.sandbox.paypal.com/checkoutnow?token=PLANTED-ORDER-ID";
const checkResponse: TextCheckAnswer = {
  results: [], more: 0, cleared: 0, notJudged: 0,
  mentioned: { recalls: [{ recallNumber: "22113", title: refusal.recallTitle }], total: 1 },
  checked: { recalls: 1, from: "2022-04-07", to: "2022-04-07", yearsMissing: [2023] }, note: "Read the CPSC notice.",
};

function harness() {
  const tools: ShopperTool[] = [];
  const calls: AgentCall[] = [];
  const popup = { location: { replace: vi.fn() }, close: vi.fn(), opener: {} as unknown };
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).startsWith("/api/shopper/listings")) return Response.json({ offerable: [offer], refused: [refusal] });
    if (String(url).startsWith("/api/check")) return Response.json(checkResponse);
    return Response.json({ approveUrl: secretUrl, orderId: "PLANTED-ORDER-ID", payer: "PLANTED-PAYER", amount: "PLANTED-AMOUNT" });
  });
  const registerTool = vi.fn(async (tool: ShopperTool, options: { signal: AbortSignal }) => { if (!options.signal.aborted) tools.push(tool); });
  const open = vi.fn(() => popup);
  const stop = registerShopperTools({ modelContext: { registerTool } }, { fetch: fetcher, open, onCall: (call) => calls.push(call) });
  const run = async (name: string, input: unknown) => {
    const tool = tools.find((tool) => tool.name === name);
    expect(tool).toBeDefined();
    return tool!.execute(input, { signal: new AbortController().signal });
  };
  return { tools, calls, popup, fetcher, registerTool, open, stop, run };
}

describe("shopper site tools", () => {
  it("does nothing without document.modelContext, including the legacy navigator-only case", () => {
    const onCall = vi.fn();
    expect(() => registerShopperTools({}, { fetch, open: vi.fn(), onCall })()).not.toThrow();
    expect(onCall).not.toHaveBeenCalled();
  });

  it("registers only the three named tools with JSON schemas and aborts registration on unmount", () => {
    const h = harness();
    expect(h.tools.map((t) => t.name)).toEqual(["search_listings", "check_recall", "start_checkout"]);
    for (const tool of h.tools) expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    const signal = h.registerTool.mock.calls[0][1].signal;
    h.stop();
    expect(signal.aborted).toBe(true);
  });

  it("search offers public listing fields, refuses Clikk under 22113, and retains the slip privately", async () => {
    const h = harness();
    const result = await h.run("search_listings", { query: "high chair", maxPrice: 50 });
    expect(result).toMatchObject({ offerable: [{ id: "tub", price: 24.99, retailer: "store.example" }], refused: [{ recallNumber: "22113", recallTitle: refusal.recallTitle }] });
    expect(JSON.stringify(result)).not.toContain("private-slip");
    const before = h.fetcher.mock.calls.length;
    expect(await h.run("start_checkout", { listingId: "clikk" })).toMatchObject({ refused: true, recalls: [{ recallNumber: "22113" }] });
    expect(h.fetcher).toHaveBeenCalledTimes(before);
    expect(h.open).not.toHaveBeenCalled();
  });

  it("refuses an unknown listing without inventing a recall number or changing anything", async () => {
    const h = harness();
    expect(await h.run("start_checkout", { listingId: "unknown" })).toMatchObject({ refused: true, recalls: [] });
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("uses the slip/buy path, opens PayPal, and never returns or logs any PayPal response field", async () => {
    const h = harness();
    const results = [await h.run("search_listings", { query: "tub" }), await h.run("check_recall", { title: refusal.title })];
    results.push(await h.run("start_checkout", { listingId: "tub" }));
    expect(results[2]).toBe(PAYPAL_OPENED);
    expect(PAYPAL_OPENED).toBe("PayPal's page is open for the buyer to review and approve.");
    expect(h.fetcher.mock.calls.at(-1)?.[0]).toBe("/api/shopper/buy");
    expect(String(h.fetcher.mock.calls.at(-1)?.[1]?.body)).toBe("slip=private-slip");
    expect(h.popup.location.replace).toHaveBeenCalledWith(secretUrl);
    const bytes = JSON.stringify({ results, calls: h.calls });
    for (const planted of ["PLANTED-ORDER-ID", secretUrl, "PLANTED-PAYER", "PLANTED-AMOUNT", "approveUrl", "orderId"]) expect(bytes).not.toContain(planted);
  });

  it("reports a newly recalled offer and closes the unused tab", async () => {
    const h = harness();
    await h.run("search_listings", { query: "tub" });
    h.fetcher.mockResolvedValueOnce(Response.json({ refused: true, error: "The listing now names a recall.", recalls: [{ recallNumber: "22113", title: refusal.recallTitle }] }, { status: 409 }));
    expect(await h.run("start_checkout", { listingId: "tub" })).toMatchObject({ refused: true, recalls: [{ recallNumber: "22113" }] });
    expect(h.popup.close).toHaveBeenCalledOnce();
    expect(h.popup.location.replace).not.toHaveBeenCalled();
  });

  it("never sends PayPal data through an error response, exception, invalid input or call log", async () => {
    const h = harness();
    await h.run("search_listings", { query: "tub" });
    h.fetcher.mockResolvedValueOnce(Response.json({ error: secretUrl, orderId: "PLANTED-ORDER-ID" }, { status: 500 }));
    const failed = await h.run("start_checkout", { listingId: "tub" });
    h.fetcher.mockRejectedValueOnce(new Error(secretUrl));
    const thrown = await h.run("check_recall", { title: "tub" });
    const invalid = await h.run("start_checkout", { listingId: "tub", approveUrl: secretUrl });
    expect(JSON.stringify([failed, thrown, invalid, h.calls])).not.toContain("PLANTED-ORDER-ID");
  });

  it("doesn't spend a slip if pop-ups are blocked", async () => {
    const h = harness();
    await h.run("search_listings", { query: "tub" });
    h.open.mockReturnValueOnce(null as never);
    expect(await h.run("start_checkout", { listingId: "tub" })).toMatchObject({ refused: true });
    expect(h.fetcher).toHaveBeenCalledOnce();
  });

  it("shows a call and its recall number in the Agent tools panel", async () => {
    const h = harness();
    await h.run("search_listings", { query: "high chair", maxPrice: 50 });
    const html = renderToStaticMarkup(createElement(AgentCallPanel, { calls: h.calls }));
    expect(html).toContain("Agent tools");
    expect(html).toContain("search_listings");
    expect(html).toContain("high chair");
    expect(html).toContain("22113");
  });

  it("preserves the public check's mentioned recalls and coverage, without a false clear in the panel", async () => {
    const h = harness();
    expect(await h.run("check_recall", { title: "Stokke" })).toEqual(checkResponse);
    expect(h.calls.at(-1)?.result).toBe("Check incomplete. Read CPSC recall 22113");
  });

  it("cancels an in-flight checkout, closes its blank tab, and never returns PayPal data", async () => {
    const h = harness();
    await h.run("search_listings", { query: "tub" });
    const controller = new AbortController();
    h.fetcher.mockImplementationOnce(async (_url, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return Response.json({ approveUrl: secretUrl });
    });
    const result = await h.tools[2].execute({ listingId: "tub" }, { signal: controller.signal });
    expect(result).toMatchObject({ refused: true });
    expect(JSON.stringify(result)).not.toContain("PLANTED-ORDER-ID");
    expect(h.popup.close).toHaveBeenCalledOnce();
    expect(h.popup.location.replace).not.toHaveBeenCalled();
  });

  it("isolates synchronous and asynchronous registration failures from the page", async () => {
    const deps = { fetch, open: vi.fn(), onCall: vi.fn() };
    expect(() => registerShopperTools({ modelContext: { registerTool: () => { throw new Error("disabled"); } } }, deps)).not.toThrow();
    const stop = registerShopperTools({ modelContext: { registerTool: async () => { throw new Error("disabled"); } } }, deps);
    await Promise.resolve();
    stop();
  });
});
