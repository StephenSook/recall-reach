import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/types";
import type { ShopSession } from "@/server/session/session";
import { testDb } from "@/test/pglite";
import { doorLedgerSale, doorLedgerShop } from "@/test/doorLedger";
import { migrate } from "@/server/db/migrate";
import { createShop } from "@/server/import/store";
import { prepareNotice } from "@/server/notice/store";
import { receiptQr } from "@/server/safetyReceipt/qr";

const state = vi.hoisted(() => ({ db: null as Db | null, session: null as ShopSession | null, getDb: vi.fn() }));
vi.mock("@/server/db/pg", () => ({ getDb: () => { state.getDb(); return state.db; } }));
vi.mock("@/server/web/http", async (original) => ({ ...(await original<object>()), currentSession: async () => state.session }));
vi.mock("@/server/safetyReceipt/qr", { spy: true });
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT ${path}`); },
  notFound: () => { throw new Error("NOT FOUND"); },
}));

import DoorNoticePage from "./page";
import { GET, POST } from "@/app/api/queue/notices/[id]/door/route";

describe("owner door notice page and print route", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let noticeId: string;
  const context = () => ({ params: Promise.resolve({ id: noticeId }) });
  const page = async () => renderToStaticMarkup(createElement("div", null, await DoorNoticePage(context())));
  const get = () => GET(new Request("https://example.test/api/queue/notices/door"), context());
  const post = (actionId: string, origin: string | null = "https://example.test") => POST(new Request("https://example.test/api/queue/notices/door", {
    method: "POST", headers: { ...(origin ? { origin } : {}), "content-type": "application/json" }, body: JSON.stringify({ actionId }),
  }), context());
  beforeEach(async () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "https://example.test");
    db = await testDb();
    await migrate(db);
    shopId = await doorLedgerShop(db);
    const { matchId } = await doorLedgerSale(db, shopId);
    ({ noticeId } = await prepareNotice(db, { shopId, matchId }));
    state.db = db;
    state.session = { shopId, sessionId: "owner-session" };
    state.getDb.mockClear();
    vi.mocked(receiptQr).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses the page, history and print action without a session before reading the database", async () => {
    state.session = null;
    await expect(page()).rejects.toThrow("REDIRECT /?demo=noqueue");
    expect((await get()).status).toBe(401);
    expect((await post(crypto.randomUUID())).status).toBe(401);
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("refuses another shop's notice on the page, history and write route", async () => {
    state.session = { shopId: await createShop(db, { name: "Other", kind: "REAL" }), sessionId: "other-session" };
    await expect(page()).rejects.toThrow("NOT FOUND");
    expect((await get()).status).toBe(404);
    expect((await post(crypto.randomUUID())).status).toBe(404);
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(0);
  });

  it("points at the existing public recall route, and a page view records no print", async () => {
    const html = await page();
    const printedUrl = html.match(/<a class="door-url" href="([^"]+)">([^<]+)<\/a>/);
    expect(printedUrl?.[1]).toBe("https://example.test/recall/22200");
    expect(printedUrl?.[2]).toBe(printedUrl?.[1]);
    expect(receiptQr).toHaveBeenCalledExactlyOnceWith(printedUrl?.[2]);
    const qr = await vi.mocked(receiptQr).mock.results[0].value;
    expect(qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(html).toContain(`src="${qr}"`);
    const svg = Buffer.from(qr.split(",")[1], "base64").toString();
    expect(svg).toContain("<svg");
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('fill="#ffffff"');
    expect(html).toContain("CPSC recall 22200. Recall date: 2022-08-15.");
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(0);
  });

  it("records one print action once, and exposes only its timestamp to the queue card", async () => {
    const id = crypto.randomUUID();
    const a = await post(id);
    const b = await post(id);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const first = await a.json();
    expect(await b.json()).toEqual(first);
    const history = await get();
    expect(history.headers.get("cache-control")).toBe("no-store");
    expect(await history.json()).toEqual(first);
    expect(Object.keys(first)).toEqual(["printedAt"]);
    expect((await db.query("select 1 from notice_door_prints")).rows).toHaveLength(1);
  });

  it("refuses cross-site and missing-origin writes before the database", async () => {
    expect((await post(crypto.randomUUID(), "https://other.test")).status).toBe(401);
    expect((await post(crypto.randomUUID(), null)).status).toBe(401);
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("refuses malformed JSON and invalid action ids", async () => {
    expect((await post("bad")).status).toBe(400);
    const res = await POST(new Request("https://example.test/door", { method: "POST", headers: { origin: "https://example.test" }, body: "{" }), context());
    expect(res.status).toBe(400);
  });

  it("limits print actions per shop", async () => {
    for (let i = 0; i < 60; i++) expect((await post(crypto.randomUUID())).status).toBe(200);
    expect((await post(crypto.randomUUID())).status).toBe(429);
  });

  it("refuses an oversized body before reading any database rows", async () => {
    const response = await POST(new Request("https://example.test/door", {
      method: "POST", headers: { origin: "https://example.test" }, body: JSON.stringify({ actionId: "x".repeat(2000) }),
    }), context());
    expect(response.status).toBe(413);
    expect(state.getDb).not.toHaveBeenCalled();
  });
});
