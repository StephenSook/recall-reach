import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ runShopper: vi.fn(), createSlip: vi.fn(), start: vi.fn(), finish: vi.fn(), agent: vi.fn(), found: vi.fn() }));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/agent/shopper", async (original) => ({ ...(await original<typeof import("@/server/agent/shopper")>()), runShopper: paths.runShopper }));
vi.mock("@/server/agent/claude", async (original) => ({ ...(await original<typeof import("@/server/agent/claude")>()), agentClientFromEnv: paths.agent }));
vi.mock("@/server/paypal/client", async (original) => ({ ...(await original<typeof import("@/server/paypal/client")>()), payPalClientFromEnv: () => ({}) }));
vi.mock("@/server/paypal/shopperOrder", async (original) => ({
  ...(await original<typeof import("@/server/paypal/shopperOrder")>()),
  createSlip: paths.createSlip,
  startShopperOrder: paths.start,
  finishShopperOrder: paths.finish,
  readFinishedSlip: paths.found,
}));

import { SlipRefused } from "@/server/paypal/shopperOrder";
import ShopperPage from "@/app/shopper/page";
import { POST as buy } from "./buy/route";
import { GET as back } from "./return/route";
import { POST as run } from "./run/route";

const ORIGIN = "http://localhost:3000";
const LISTING = { id: "raw-id", title: "Folding Tub", brand: "Acme", priceCents: 2499, currency: "USD" };
const asking = (body: unknown, origin = ORIGIN, ip = "1.2.3.4") =>
  new Request(`${ORIGIN}/api/shopper/run`, { method: "POST", headers: { origin, "content-type": "application/json", "true-client-ip": ip }, body: JSON.stringify(body) });
let visitor = 0;
const nextIp = () => `10.0.0.${++visitor}`;

describe("the shopping agent's routes", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
    vi.stubEnv("SITE_URL", ORIGIN);
    for (const fn of Object.values(paths)) fn.mockReset();
    paths.agent.mockReturnValue({});
    paths.createSlip.mockResolvedValue({ id: "slip-1", expiresAt: "x" });
    paths.runShopper.mockResolvedValue({ outcome: "NO_PICK", steps: [], blocked: [], pick: null });
  });

  describe("asking it", () => {
    it("must come from a page on this site", async () => {
      expect((await run(asking({ ask: "a tub", budget: 50 }, "https://elsewhere.example", nextIp()))).status).toBe(403);
      expect(paths.runShopper).not.toHaveBeenCalled();
    });

    it.each([
      [{ ask: "x", budget: 50 }],
      [{ ask: "a tub", budget: 0 }],
      [{ ask: "a tub", budget: 2001 }],
      [{ ask: "a tub", budget: "50" }],
      [{ ask: "a".repeat(201), budget: 50 }],
    ])("refuses %j and spends nothing", async (body) => {
      expect((await run(asking(body, ORIGIN, nextIp()))).status).toBe(400);
      expect(paths.runShopper).not.toHaveBeenCalled();
    });

    it("turns the budget into cents itself", async () => {
      await run(asking({ ask: "a tub", budget: 49.5 }, ORIGIN, nextIp()));
      expect(paths.runShopper.mock.calls[0][2]).toMatchObject({ ask: "a tub", budgetCents: 4950 });
    });

    it("limits how often one visitor can run it", async () => {
      const ip = nextIp();
      for (let i = 0; i < 5; i++) await run(asking({ ask: "a tub", budget: 50 }, ORIGIN, ip));
      const res = await run(asking({ ask: "a tub", budget: 50 }, ORIGIN, ip));
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ outcome: "BUSY" });
      expect(paths.runShopper).toHaveBeenCalledTimes(5);
    });

    it("says unavailable with no key", async () => {
      paths.agent.mockReturnValue(null);
      expect(await (await run(asking({ ask: "a tub", budget: 50 }, ORIGIN, nextIp()))).json()).toMatchObject({ outcome: "UNAVAILABLE" });
    });

    it("makes a slip only for an offer, and sends the page no listing id", async () => {
      paths.runShopper.mockResolvedValue({ outcome: "PICKED", steps: [], blocked: [{ listing: { ...LISTING, id: "raw-blocked" }, recalls: [] }], pick: { listing: LISTING, recallsChecked: 1855, from: "2022-01-05", similar: 2 } });
      const res = await run(asking({ ask: "a tub", budget: 50 }, ORIGIN, nextIp()));
      const text = JSON.stringify(await res.json());
      expect(paths.createSlip).toHaveBeenCalledOnce();
      expect(text).toContain("slip-1");
      expect(text).not.toContain("raw-id");
      expect(text).not.toContain("raw-blocked");
      paths.createSlip.mockClear();
      paths.runShopper.mockResolvedValue({ outcome: "NO_PICK", steps: [], blocked: [], pick: null });
      await run(asking({ ask: "a tub", budget: 50 }, ORIGIN, nextIp()));
      expect(paths.createSlip).not.toHaveBeenCalled();
    });
  });

  describe("approving an offer", () => {
    const pressing = (origin = ORIGIN) => new Request(`${ORIGIN}/api/shopper/buy`, { method: "POST", headers: { origin, "true-client-ip": nextIp(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slip: "slip-1", price: "1" }) });

    it("must come from a page on this site", async () => {
      expect((await buy(pressing("https://elsewhere.example"))).status).toBe(403);
      expect(paths.start).not.toHaveBeenCalled();
    });

    it("sends the person to PayPal, and takes only the slip from the form", async () => {
      paths.start.mockResolvedValue({ approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=T" });
      const res = await buy(pressing());
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("https://www.sandbox.paypal.com/checkoutnow?token=T");
      expect(Object.keys(paths.start.mock.calls[0][2]).sort()).toEqual(["now", "siteUrl", "slipId"]);
    });

    it("says why it stopped", async () => {
      paths.start.mockRejectedValue(new SlipRefused("CHANGED", "x"));
      expect(new URL((await buy(pressing())).headers.get("location") ?? "").search).toBe("?error=CHANGED");
    });
  });

  describe("back from PayPal", () => {
    const returning = (query: string) => new Request(`${ORIGIN}/api/shopper/return?${query}`);

    it("reads the order and shows it done only if that worked", async () => {
      paths.finish.mockResolvedValue(undefined);
      expect(new URL((await back(returning("slip=s1&token=T"))).headers.get("location") ?? "").pathname).toBe("/shopper/done");
      expect(paths.finish.mock.calls[0][2]).toMatchObject({ slipId: "s1", orderId: "T" });
      paths.finish.mockRejectedValue(new SlipRefused("NOT_PAID", "x"));
      const refused = new URL((await back(returning("slip=s1&token=T"))).headers.get("location") ?? "");
      expect(refused.pathname + refused.search).toBe("/shopper?error=NOT_PAID");
    });
  });

  describe("the page", () => {
    const page = async (params: Record<string, string> = {}) => renderToStaticMarkup(createElement("div", null, await ShopperPage({ searchParams: Promise.resolve(params) })));

    it("says the agent can't set a price or buy, and that it's test money", async () => {
      const html = await page();
      expect(html).toContain("The agent never sees a price and can&#x27;t set one.");
      expect(html).toContain("It&#x27;s test money, nothing ships, and no store is paid.");
    });

    it("shows only its own sentences for an error code", async () => {
      expect(await page({ error: "CHANGED" })).toContain("price or title changed");
      expect(await page({ error: "<script>" })).not.toContain("script&gt;");
      expect(await page({ cancelled: "1" })).toContain("You cancelled at PayPal. Nothing was bought.");
    });
  });
});
