import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { migrate } from "@/server/db/migrate";
import { createShop } from "@/server/import/store";
import { shopReceiptLink } from "@/server/safetyReceipt/store";

vi.mock("@/server/db/pg", () => ({ getDb: vi.fn() }));
import { getDb } from "@/server/db/pg";
import { POST } from "./route";

describe("public safety receipt submit", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let token: string;
  let ip: number;
  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("SHOP_DATA_KEY", "k".repeat(32));
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    db = await testDb();
    await migrate(db);
    vi.mocked(getDb).mockReturnValue(db);
    token = (await shopReceiptLink(db, await createShop(db, { name: "DEMO SHOP", kind: "DEMO" }), "s".repeat(32)))!;
    ip = 0;
  });
  afterEach(async () => { vi.unstubAllEnvs(); await db.close(); });
  const submit = (over = {}, origin = "http://localhost:3000") => POST(new Request("http://localhost:3000/api/safety-receipts", {
    method: "POST", headers: { origin, "content-type": "application/json", "true-client-ip": `198.51.100.${++ip}` },
    body: JSON.stringify({ token, item: "A high chair", email: "private@example.test", consent: true, website: "", ...over }),
  }));

  it("returns a bookmarkable deletion path with no email or shop id", async () => {
    const response = await submit();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.deletePath).toMatch(/^\/s\/delete\/[\w-]{43}$/);
    expect(JSON.stringify(body)).not.toContain("private@example.test");
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(1);
  });

  it("refuses missing consent, honeypot, invalid links and foreign origins", async () => {
    expect((await submit({ consent: false })).status).toBe(400);
    expect((await submit({ website: "bot" })).status).toBe(400);
    expect((await submit({ token: "tampered" })).status).toBe(404);
    expect((await submit({}, "https://another.test")).status).toBe(403);
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(0);
  });

  it("rate limits submissions at the HTTP boundary before storing", async () => {
    const request = () => new Request("http://localhost:3000/api/safety-receipts", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", "true-client-ip": "203.0.113.79" },
      body: JSON.stringify({ token, item: "A chair", email: "private@example.test", consent: true }),
    });
    for (let i = 0; i < 5; i++) expect((await POST(request())).status).toBe(201);
    const limited = await POST(request());
    expect(limited.status).toBe(429);
    expect((await db.query("select * from safety_receipts")).rows).toHaveLength(5);
  });

  it("rejects malformed and oversized bodies without logging their contents", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(new Request("http://localhost:3000/api/safety-receipts", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "x".repeat(17_000),
    }));
    expect(response.status).toBe(413);
    const malformed = await POST(new Request("http://localhost:3000/api/safety-receipts", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{",
    }));
    expect(malformed.status).toBe(400);
    expect(logs).not.toHaveBeenCalled();
    logs.mockRestore();
  });
});
