import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "csv-parse/sync";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/types";
import type { ShopSession } from "@/server/session/session";
import { testDb } from "@/test/pglite";
import { doorLedgerShop } from "@/test/doorLedger";
import { migrate } from "@/server/db/migrate";
import { createShop } from "@/server/import/store";
import { PAST_WINDOW_SAMPLE } from "@/server/paypal/payouts";
import { readSentLedger, SENT_COLUMNS, sentCells } from "@/server/paypal/sentLedger";

const state = vi.hoisted(() => ({ db: null as Db | null, session: null as ShopSession | null, getDb: vi.fn() }));
vi.mock("@/server/db/pg", () => ({ getDb: () => { state.getDb(); return state.db; } }));
vi.mock("@/server/web/http", async (original) => ({ ...(await original<object>()), currentSession: async () => state.session }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT ${path}`); } }));

import SentLedgerPage from "./page";
import { GET } from "./csv/route";

describe("owner refunds sent page and CSV", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  const page = async () => renderToStaticMarkup(createElement("div", null, await SentLedgerPage()));
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await doorLedgerShop(db);
    state.db = db;
    state.session = { shopId, sessionId: "owner-session" };
    state.getDb.mockClear();
  });

  async function sentPayout(shop: string, amount: number) {
    await db.query(
      `insert into payouts (shop_id, session_id, sample_key, receiver_enc, amount_cents, currency, status, paypal_status, expires_at)
       values ($1, 'owner-session', $2, 'PRIVATE-RECEIVER', $3, 'USD', 'paid', 'SUCCESS', now())`,
      [shop, PAST_WINDOW_SAMPLE.key, amount],
    );
  }

  it("refuses both page and download without a session, before reading any rows", async () => {
    state.session = null;
    await expect(page()).rejects.toThrow("REDIRECT /?demo=noqueue");
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("shows only this shop's rows in both table and attachment", async () => {
    await sentPayout(shopId, 2400);
    const other = await createShop(db, { name: "Other shop", kind: "DEMO" });
    await sentPayout(other, 1999);
    const html = await page();
    expect(html).toContain("24.00");
    expect(html).not.toContain("19.99");
    expect(html).toContain("SUCCESS");
    expect(html).toContain('href="/queue/sent/csv"');
    expect(html).toContain('href="/queue#past-window"');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="recall-reach-refunds.csv"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csv = await response.text();
    const rows = await readSentLedger(db, shopId);
    expect(parse(csv)).toEqual([SENT_COLUMNS, ...rows.map(sentCells)]);
    expect(csv).not.toContain("19.99");
    expect(csv).not.toContain("PRIVATE-RECEIVER");
    for (const cell of sentCells(rows[0]).slice(0, -1)) {
      expect(html).toContain(renderToStaticMarkup(createElement("span", null, cell)).slice(6, -7));
    }
  });

  it("has a plain empty state and still downloads valid header-only CSV", async () => {
    expect(await page()).toContain("No refunds or payouts sent yet.");
    const response = await GET();
    expect(parse(await response.text())).toEqual([SENT_COLUMNS]);
  });

  it("does not turn a database error into an empty ledger", async () => {
    state.db = { query: async () => { throw new Error("database unavailable"); } } as unknown as Db;
    await expect(page()).rejects.toThrow("database unavailable");
    await expect(GET()).rejects.toThrow("database unavailable");
  });
});
