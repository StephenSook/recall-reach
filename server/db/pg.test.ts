import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, POOL_CONFIG } from "./pg";

describe("POOL_CONFIG", () => {
  it("bounds every query on the client", () => {
    expect(POOL_CONFIG.query_timeout).toBeGreaterThan(0);
    expect(POOL_CONFIG.keepAlive).toBe(true);
  });

  it("lets idle connections go quickly so they never hold the Neon compute awake", () => {
    expect(POOL_CONFIG.idleTimeoutMillis).toBeLessThanOrEqual(10_000);
    expect(POOL_CONFIG.min ?? 0).toBe(0);
  });
});

describe("getDb", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("refuses to start without DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => getDb()).toThrow(/DATABASE_URL is not set/);
  });

  it("refuses a DATABASE_URL that is not a postgres URL", () => {
    vi.stubEnv("DATABASE_URL", "mysql://user:pw@localhost/db");
    expect(() => getDb()).toThrow(/postgres/);
  });

  it("returns the same pool on every call", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@localhost:5432/db");
    expect(getDb()).toBe(getDb());
  });
});
