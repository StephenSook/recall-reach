import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { migrate } from "@/server/db/migrate";
import { createShop } from "@/server/import/store";
import { pullRecalls } from "@/server/cpsc/pull";
import { createReceipt } from "@/server/safetyReceipt/store";
import { sessionCookie } from "@/server/session/session";
import { prepareNotice, markSent } from "@/server/notice/store";
import { loadQueue } from "@/server/queue/queue";
import { runShopCheck } from "@/server/match/run";

vi.mock("@/server/db/pg", () => ({ getDb: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", async (original) => ({ ...await original<typeof import("next/navigation")>(), useRouter: () => ({ refresh: vi.fn() }) }));
import { getDb } from "@/server/db/pg";
import { cookies } from "next/headers";
import QueuePage from "./page";

afterEach(() => vi.unstubAllEnvs());

describe("a receipt on the existing queue screen", () => {
  it("handles a real shop with listings and receipt cards without listing-only counts", async () => {
    vi.stubEnv("SESSION_SECRET", "k".repeat(32));
    vi.stubEnv("SHOP_DATA_KEY", "k".repeat(32));
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const db = await testDb();
    await migrate(db);
    const shopId = await createShop(db, { name: "Real shop", kind: "REAL" });
    vi.mocked(getDb).mockReturnValue(db);
    const value = sessionCookie("k".repeat(32), shopId).value;
    vi.mocked(cookies).mockResolvedValue({ get: () => ({ value }) } as unknown as Awaited<ReturnType<typeof cookies>>);
    const fixture = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: (async () => new Response(fixture)) as typeof fetch });
    await db.query("insert into shop_items (shop_id, title, source) values ($1, 'A book', 'test')", [shopId]);
    for (let i = 0; i < 2; i++) await createReceipt(db, shopId, { item: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", email: "private@example.test", consent: true }, "k".repeat(32));
    await runShopCheck(db, shopId, { today: "2026-11-07" });
    const q = await loadQueue(db, shopId, "owner");
    const card = q.rows.find((r) => r.familyAsked && r.recallNumber === "27072")!;
    const notice = await prepareNotice(db, { shopId, matchId: card.matchId });
    await markSent(db, { shopId, noticeId: notice.noticeId });
    const tree = await QueuePage({ searchParams: Promise.resolve({}) });
    const page = renderToStaticMarkup(tree);
    expect(page).not.toContain("Not flagged");
    expect(page).not.toContain('data-testid="listings-lead"');
    // Read the actual grid props passed by the server, including the sent receipt's wait state.
    const children = tree.props.children as { props?: { rows?: { matchId: string; waits: boolean }[]; listings?: boolean } }[];
    const grid = children.find((child) => child?.props?.rows)?.props;
    expect(grid?.listings).toBe(false);
    expect(grid?.rows?.find((r) => r.matchId === card.matchId)?.waits).toBe(false);
    await db.close();
  });

  it("renders the family label, notice approval and QR, with no Claude or refund action", async () => {
    vi.stubEnv("SESSION_SECRET", "k".repeat(32));
    vi.stubEnv("SHOP_DATA_KEY", "k".repeat(32));
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("DEMO_PAYOUT_RECEIVER", "");
    const db = await testDb();
    await migrate(db);
    const shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    vi.mocked(getDb).mockReturnValue(db);
    const value = sessionCookie("k".repeat(32), shopId).value;
    vi.mocked(cookies).mockResolvedValue({ get: () => ({ value }) } as unknown as Awaited<ReturnType<typeof cookies>>);
    const fixture = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: (async () => new Response(fixture)) as typeof fetch });
    await createReceipt(db, shopId, { item: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", email: "private@example.test", consent: true }, "k".repeat(32));
    const page = renderToStaticMarkup(await QueuePage({ searchParams: Promise.resolve({}) }));
    expect(page).toContain("A family asked to hear about this");
    expect(page).toContain("Approve this notice");
    expect(page).toContain("Safety receipt");
    expect(page).toContain("DEMO SHOP");
    expect(page).toContain("data:image/svg+xml;base64,");
    expect(page).not.toContain("private@example.test");
    expect(page).not.toContain("Review refund");
    expect(page).not.toContain("Check with Claude");
    await db.close();
  });
});
