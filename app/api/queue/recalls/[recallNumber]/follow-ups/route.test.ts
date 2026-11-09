import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueRow } from "@/server/queue/queue";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/time/businessDay", () => ({ businessDay: () => "2026-11-09" }));
const session = vi.hoisted(() => vi.fn());
vi.mock("@/server/web/http", async (real) => ({ ...(await real<typeof import("@/server/web/http")>()), currentSession: session, fromThisSite: (r: Request) => r.headers.get("origin") === "https://site.test" }));
const loadQueue = vi.hoisted(() => vi.fn());
vi.mock("@/server/queue/queue", () => ({ loadQueue }));
const advise = vi.hoisted(() => vi.fn());
const stored = vi.hoisted(() => vi.fn());
vi.mock("@/server/agent/followUpAdvice", () => ({ adviseFollowUp: advise, storedAdvice: stored }));
const client = vi.hoisted(() => vi.fn());
vi.mock("@/server/agent/claude", async (real) => ({ ...(await real<typeof import("@/server/agent/claude")>()), agentClientFromEnv: client }));
const saved = vi.hoisted(() => ({ followUpsFor: vi.fn(), saveFollowUp: vi.fn(), dropFollowUp: vi.fn() }));
vi.mock("@/server/queue/followUps", () => saved);

import { DELETE, POST, PUT } from "./route";

const SALE = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const row = (over: Partial<QueueRow> = {}) => ({ matchId: SALE, recallNumber: "27040", recallTitle: "A recall", recallDate: "2026-10-15", itemTitle: "A high chair", orderedOn: "2026-11-01", salePath: "REFUND_ELIGIBLE", verdict: "MATCH", strength: "CONFIRMED", joinState: "IDENTIFIED", isListing: false, notice: null, refund: null, ...over }) as QueueRow;
const ADVICE = { withinDays: 3, reason: "Entrapment can seriously injure a child quickly.", hazardQuote: "entrapment hazard", snapshot: "snap-1" };
const REMINDER = { matchId: SALE, due: "2026-11-20", reason: "r", hazardQuote: "q", movedEarlier: false, snapshot: "snap-1" };
const context = { params: Promise.resolve({ recallNumber: "27040" }) };
const call = (method: "POST" | "PUT" | "DELETE", handler: typeof POST, body?: object, origin = "https://site.test") =>
  handler(new Request("https://site.test/api/queue/recalls/27040/follow-ups", { method, headers: { origin, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), context);
const propose = () => call("POST", POST);
const confirm = (body: object) => call("PUT", PUT, { snapshot: "snap-1", ...body });
const dismiss = (body: object) => call("DELETE", DELETE, body);

describe("/api/queue/recalls/[recallNumber]/follow-ups", () => {
  beforeEach(() => {
    session.mockResolvedValue({ shopId: "shop-1", sessionId: "s" });
    loadQueue.mockResolvedValue({ rows: [row()], shop: { kind: "DEMO" } });
    client.mockReturnValue({});
    advise.mockResolvedValue({ status: "ADVISED", advice: ADVICE });
    stored.mockResolvedValue(ADVICE);
    saved.followUpsFor.mockResolvedValue([]);
    saved.saveFollowUp.mockResolvedValue(true);
    saved.dropFollowUp.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("planning", () => {
    beforeEach(() => {
      stored.mockResolvedValue(null);
    });

    it("reuses advice already written for this CPSC text, and needs no call to Claude", async () => {
      stored.mockResolvedValue(ADVICE);
      client.mockReturnValue(null);
      const res = await propose();
      expect(res.status).toBe(200);
      expect((await res.json()).reason).toBe(ADVICE.reason);
      expect(advise).not.toHaveBeenCalled();
    });

    it("returns Claude's advice and the date code set for each sale", async () => {
      const res = await propose();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ reason: ADVICE.reason, hazardQuote: ADVICE.hazardQuote, withinDays: 3, snapshot: "snap-1", proposals: [{ saleId: SALE, due: "2026-11-12", movedEarlier: false }], closingSoon: 0, confirmed: [] });
    });

    it("asks about the recall by its number and nothing else, so no sale can reach Claude", async () => {
      await propose();
      expect(advise).toHaveBeenCalledTimes(1);
      const input = advise.mock.calls[0][2] as Record<string, unknown>;
      expect(Object.keys(input).sort()).toEqual(["capMicros", "now", "recallNumber"]);
      expect(input.recallNumber).toBe("27040");
    });

    it("doesn't propose again for a sale the owner already confirmed", async () => {
      saved.followUpsFor.mockResolvedValue([{ matchId: SALE, due: "2026-11-20", reason: "r", hazardQuote: "q", movedEarlier: false }]);
      expect((await (await propose()).json()).proposals).toEqual([]);
    });

    it("hands back what's saved for this recall, so a page that missed a save catches up", async () => {
      saved.followUpsFor.mockResolvedValue([REMINDER]);
      expect((await (await propose()).json()).confirmed).toEqual([REMINDER]);
    });

    it("leaves out a reminder on a sale that no longer needs one", async () => {
      saved.followUpsFor.mockResolvedValue([REMINDER]);
      loadQueue.mockResolvedValue({ rows: [row({ notice: { state: "FAMILY_RESPONDED", stopped: false } as never })], shop: { kind: "DEMO" } });
      expect((await (await propose()).json()).confirmed).toEqual([]);
    });

    it("counts the sales too close to the end of their window", async () => {
      loadQueue.mockResolvedValue({ rows: [row({ orderedOn: "2026-05-19" })], shop: { kind: "DEMO" } });
      expect(await (await propose()).json()).toMatchObject({ proposals: [], closingSoon: 1 });
    });

    it("wants a session", async () => {
      session.mockResolvedValue(null);
      expect((await propose()).status).toBe(401);
      expect(advise).not.toHaveBeenCalled();
    });

    it("wants it to come from this site", async () => {
      expect((await call("POST", POST, undefined, "https://elsewhere.test")).status).toBe(401);
      expect(advise).not.toHaveBeenCalled();
    });

    it("finds nothing for a recall this shop has no sale of", async () => {
      loadQueue.mockResolvedValue({ rows: [row({ recallNumber: "11111" })], shop: { kind: "DEMO" } });
      expect((await propose()).status).toBe(404);
      expect(advise).not.toHaveBeenCalled();
    });

    it("says so when Claude isn't set up", async () => {
      client.mockReturnValue(null);
      expect((await propose()).status).toBe(503);
    });

    it.each([
      ["NO_ADVICE", 502],
      ["UNAVAILABLE", 503],
      ["OVER_BUDGET", 429],
      ["NO_SUCH_RECALL", 404],
    ])("reports %s as %i and proposes nothing", async (status, code) => {
      advise.mockResolvedValue({ status });
      const res = await propose();
      expect(res.status).toBe(code);
      const body = await res.json();
      expect(body.proposals).toBeUndefined();
      expect(typeof body.error).toBe("string");
    });
  });

  describe("confirming", () => {
    it("saves the date, with Claude's reason read on the server", async () => {
      expect((await confirm({ saleId: SALE, due: "2026-11-12" })).status).toBe(200);
      expect(saved.saveFollowUp).toHaveBeenCalledWith({}, { shopId: "shop-1", matchId: SALE, due: "2026-11-12", reason: ADVICE.reason, hazardQuote: ADVICE.hazardQuote, movedEarlier: false, snapshot: "snap-1" });
    });

    it("ignores a reason or quote the page sends", async () => {
      await confirm({ saleId: SALE, due: "2026-11-12", reason: "forged", hazardQuote: "forged" });
      expect(JSON.stringify(saved.saveFollowUp.mock.calls[0][1])).not.toContain("forged");
    });

    it("records when the window moved the date earlier", async () => {
      loadQueue.mockResolvedValue({ rows: [row({ orderedOn: "2026-05-21" })], shop: { kind: "DEMO" } });
      await confirm({ saleId: SALE, due: "2026-11-10" });
      expect(saved.saveFollowUp.mock.calls[0][1]).toMatchObject({ due: "2026-11-10", movedEarlier: true });
    });

    it("runs the date check on the server, whatever the page thinks", async () => {
      loadQueue.mockResolvedValue({ rows: [row({ orderedOn: "2026-05-25" })], shop: { kind: "DEMO" } });
      const res = await confirm({ saleId: SALE, due: "2026-11-30" });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/week/);
      expect(saved.saveFollowUp).not.toHaveBeenCalled();
    });

    it.each([
      ["a day already gone", "2026-11-01", /gone/],
      ["something that isn't a date", "soon", /day/],
    ])("refuses %s", async (_name, due, words) => {
      const res = await confirm({ saleId: SALE, due });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(words);
    });

    it("refuses a sale that isn't this shop's", async () => {
      expect((await confirm({ saleId: OTHER, due: "2026-11-12" })).status).toBe(404);
      expect(saved.saveFollowUp).not.toHaveBeenCalled();
    });

    it("refuses a sale whose family has already answered", async () => {
      loadQueue.mockResolvedValue({ rows: [row({ notice: { state: "FAMILY_RESPONDED", stopped: false } as never })], shop: { kind: "DEMO" } });
      expect((await confirm({ saleId: SALE, due: "2026-11-12" })).status).toBe(409);
      expect(saved.saveFollowUp).not.toHaveBeenCalled();
    });

    it("wants advice to exist first, so a date can't be saved with no reason behind it", async () => {
      stored.mockResolvedValue(null);
      expect((await confirm({ saleId: SALE, due: "2026-11-12" })).status).toBe(409);
      expect(saved.saveFollowUp).not.toHaveBeenCalled();
    });

    it("refuses advice the owner reviewed if CPSC has changed the recall since", async () => {
      const res = await confirm({ saleId: SALE, due: "2026-11-12", snapshot: "an-older-one" });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/Plan/);
      expect(saved.saveFollowUp).not.toHaveBeenCalled();
    });

    it("asks to plan again if CPSC changes it as this is saved", async () => {
      saved.saveFollowUp.mockResolvedValue(false);
      expect((await confirm({ saleId: SALE, due: "2026-11-12" })).status).toBe(409);
    });

    describe("when the save no longer stands, it tells the page what's saved now", () => {
      it("after CPSC changed the recall", async () => {
        const res = await confirm({ saleId: SALE, due: "2026-11-12", snapshot: "an-older-one" });
        expect(res.status).toBe(409);
        expect((await res.json()).confirmed).toEqual([]);
      });

      it("after the family answered, leaving that sale's reminder out", async () => {
        saved.followUpsFor.mockResolvedValue([REMINDER]);
        loadQueue.mockResolvedValue({ rows: [row({ notice: { state: "FAMILY_RESPONDED", stopped: false } as never })], shop: { kind: "DEMO" } });
        const res = await confirm({ saleId: SALE, due: "2026-11-12" });
        expect(res.status).toBe(409);
        expect((await res.json()).confirmed).toEqual([]);
      });

      it("after advice went missing", async () => {
        stored.mockResolvedValue(null);
        saved.followUpsFor.mockResolvedValue([REMINDER]);
        expect((await (await confirm({ saleId: SALE, due: "2026-11-12" })).json()).confirmed).toEqual([REMINDER]);
      });

      it("if CPSC changes it as this is saved", async () => {
        saved.saveFollowUp.mockResolvedValue(false);
        expect((await (await confirm({ saleId: SALE, due: "2026-11-12" })).json()).confirmed).toEqual([]);
      });

      it("for a sale that has gone, keeping the others", async () => {
        saved.followUpsFor.mockResolvedValue([REMINDER]);
        const res = await confirm({ saleId: OTHER, due: "2026-11-12" });
        expect(res.status).toBe(404);
        expect((await res.json()).confirmed).toEqual([REMINDER]);
      });

      it("but a date the window can't take changes nothing, so it isn't sent", async () => {
        const res = await confirm({ saleId: SALE, due: "2026-11-01" });
        expect(res.status).toBe(422);
        expect((await res.json()).confirmed).toBeUndefined();
      });
    });

    it("refuses a confirmation with no snapshot", async () => {
      expect((await call("PUT", PUT, { saleId: SALE, due: "2026-11-12" })).status).toBe(400);
    });

    it("gives a plain answer for a date too far out", async () => {
      loadQueue.mockResolvedValue({ rows: [row({ salePath: "NOTICE_ONLY" })], shop: { kind: "DEMO" } });
      const res = await confirm({ saleId: SALE, due: "2027-02-01" });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/30 days/);
    });

    it("wants a session", async () => {
      session.mockResolvedValue(null);
      expect((await confirm({ saleId: SALE, due: "2026-11-12" })).status).toBe(401);
    });

    it("wants it to come from this site", async () => {
      expect((await call("PUT", PUT, { saleId: SALE, due: "2026-11-12" }, "https://elsewhere.test")).status).toBe(401);
    });

    it.each([
      ["no body", undefined],
      ["no sale", { due: "2026-11-12" }],
      ["a sale id that isn't one", { saleId: "1 or 1=1", due: "2026-11-12" }],
    ])("refuses %s", async (_name, body) => {
      expect((await call("PUT", PUT, body)).status).toBe(400);
      expect(saved.saveFollowUp).not.toHaveBeenCalled();
    });
  });

  describe("dismissing", () => {
    it("removes it for this shop", async () => {
      expect((await dismiss({ saleId: SALE })).status).toBe(200);
      expect(saved.dropFollowUp).toHaveBeenCalledWith({}, "shop-1", SALE);
    });

    it("wants a session", async () => {
      session.mockResolvedValue(null);
      expect((await dismiss({ saleId: SALE })).status).toBe(401);
      expect(saved.dropFollowUp).not.toHaveBeenCalled();
    });

    it("wants it to come from this site", async () => {
      expect((await call("DELETE", DELETE, { saleId: SALE }, "https://elsewhere.test")).status).toBe(401);
    });

    it("refuses a sale id that isn't one", async () => {
      expect((await dismiss({ saleId: "x" })).status).toBe(400);
    });
  });
});
