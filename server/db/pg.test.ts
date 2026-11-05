import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "./pg";

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
