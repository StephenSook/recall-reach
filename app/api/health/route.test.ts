import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { migrate } from "@/server/db/migrate";
import type { Queryable } from "@/server/db/types";

let db: Queryable | null = null;
vi.mock("@/server/db/pg", () => ({
  getDb: () => {
    if (!db) throw new Error("DATABASE_URL is not set");
    return db;
  },
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  let real: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    real = await testDb();
    await migrate(real);
    db = real;
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-ID");
    vi.stubEnv("RECORD_HMAC_SECRET", "r".repeat(32));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await real.close();
  });

  const healthy = async () => {
    await real.query("insert into cpsc_pulls (range_field, range_start, range_end, status, finished_at) values ('LastPublishDate', '2026-11-05', '2026-11-06', 'ok', now())");
    await real.query(
      `insert into replay_runs (ms, checked, matched, scope_gaps, cleared, not_near, notice_only, refund_eligible, unidentified, search_windows, failed_windows, search_complete, recalls_digest)
       values (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, true, 'x')`,
    );
  };

  it("answers 200 when every check passes, reading the record key from the environment", async () => {
    await healthy();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).ok).toBe(true);
  });

  it("answers 503 when a check fails, and says which", async () => {
    await healthy();
    vi.stubEnv("RECORD_HMAC_SECRET", "");
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).checks.webhook).toBe(false);
  });

  it("answers 503 with no detail when the database can't be reached at all", async () => {
    db = null;
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, database: { ok: false } });
  });
});
