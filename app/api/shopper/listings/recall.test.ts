import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { migrate } from "@/server/db/migrate";
import { pullRecalls } from "@/server/cpsc/pull";
import { createSlip } from "@/server/paypal/shopperOrder";
import type { BuyableListing } from "@/server/sweep/channel3";

const held = vi.hoisted(() => ({ db: null as unknown, request: vi.fn(), listing: null as unknown }));
vi.mock("@/server/db/pg", () => ({ getDb: () => held.db }));
vi.mock("@/server/sweep/channel3", () => ({ channel3Listings: () => ({ search: async () => [held.listing], read: async () => held.listing }) }));
vi.mock("@/server/paypal/client", () => ({ payPalClientFromEnv: () => ({ request: held.request }) }));
vi.mock("@/server/privacy/recordKey", () => ({ recordKeyFromEnv: () => () => "hash" }));

import { GET } from "./route";
import { POST as buy } from "../buy/route";

const ORIGIN = "http://localhost:3000";
const listing: BuyableListing = { id: "real-clikk", title: "Stokke Clikk High Chair", brand: "Stokke", priceCents: 5000, currency: "USD" };
const records = JSON.parse(gunzipSync(readFileSync(new URL("../../../../test/fixtures/cpsc/saved_records_2022_to_2026-11-05.json.gz", import.meta.url))).toString()) as { RecallNumber: string; Title: string }[];
const clikk = records.find((r) => r.RecallNumber === "22113");

describe("the actual CPSC Clikk record through search and slip checkout", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeAll(async () => {
    expect(clikk).toBeDefined();
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    db = await testDb();
    held.db = db;
    held.listing = listing;
    await migrate(db);
    await pullRecalls(db, { field: "RecallDate", start: "2022-04-07", end: "2022-04-07" }, { fetchImpl: (async () => Response.json([clikk])) as typeof fetch });
  });
  afterAll(() => vi.unstubAllEnvs());

  it("search refuses 22113 with CPSC's own title and creates no slip", async () => {
    const res = await GET(new Request(`${ORIGIN}/api/shopper/listings?query=clikk&maxPrice=100`, { headers: { origin: ORIGIN } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ offerable: [], refused: [{ recallNumber: "22113", recallTitle: clikk!.Title }] });
    expect((await db.query("select id from shopping_slips")).rows).toEqual([]);
    expect(held.request).not.toHaveBeenCalled();
  });

  it("a pre-existing slip is rechecked by the real startShopperOrder and cannot start a PayPal order", async () => {
    const slip = await createSlip(db, listing, new Date());
    const res = await buy(new Request(`${ORIGIN}/api/shopper/buy`, { method: "POST", headers: { origin: ORIGIN, accept: "application/json" }, body: new URLSearchParams({ slip: slip.id }) }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ refused: true, recalls: [{ recallNumber: "22113", title: clikk!.Title }] });
    expect(held.request).not.toHaveBeenCalled();
  });
});
