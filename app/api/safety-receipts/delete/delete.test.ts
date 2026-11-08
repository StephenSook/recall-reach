import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { migrate } from "@/server/db/migrate";
import { createShop } from "@/server/import/store";
import { createReceipt } from "@/server/safetyReceipt/store";

vi.mock("@/server/db/pg", () => ({ getDb: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
import { getDb } from "@/server/db/pg";
import { cookies } from "next/headers";
import { sessionCookie } from "@/server/session/session";
import { POST as familyDelete } from "./[token]/route";
import { POST as ownerDelete } from "../../queue/safety-receipts/[id]/delete/route";

describe("receipt deletion routes", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let saved: { id: string; deleteToken: string };
  const key = "k".repeat(32);
  const request = (origin = "http://localhost:3000") => new Request("http://localhost:3000/api/safety-receipts/delete", { method: "POST", headers: { origin } });
  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", key);
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    db = await testDb();
    await migrate(db);
    vi.mocked(getDb).mockReturnValue(db);
    shopId = await createShop(db, { name: "Shop", kind: "REAL" });
    saved = await createReceipt(db, shopId, { item: "A chair", email: "test@example.test", consent: true }, key);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await db.close(); });

  it("deletes through the family link, and repeat use has no further effect", async () => {
    const params = Promise.resolve({ token: saved.deleteToken });
    const a = await familyDelete(request(), { params });
    const b = await familyDelete(request(), { params });
    expect(a.status).toBe(303);
    expect(b.headers.get("location")).toBe(a.headers.get("location"));
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(0);
  });

  it("refuses foreign-origin deletes even with a valid deletion token", async () => {
    expect((await familyDelete(request("https://another.test"), { params: Promise.resolve({ token: saved.deleteToken }) })).status).toBe(403);
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(1);
  });

  it("requires an owner session and scopes deletion to that shop", async () => {
    const jar = { get: vi.fn((): { value: string } | undefined => undefined) };
    vi.mocked(cookies).mockResolvedValue(jar as unknown as Awaited<ReturnType<typeof cookies>>);
    const params = Promise.resolve({ id: saved.id });
    expect((await ownerDelete(request(), { params })).status).toBe(401);
    const other = await createShop(db, { name: "Other", kind: "REAL" });
    jar.get.mockReturnValue({ value: sessionCookie(key, other).value });
    expect((await ownerDelete(request(), { params })).status).toBe(303);
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(1);
    jar.get.mockReturnValue({ value: sessionCookie(key, shopId).value });
    expect((await ownerDelete(request(), { params })).status).toBe(303);
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(0);
  });
});
