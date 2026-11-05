import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/live", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers 200 without a database, so host health checks never wake Postgres", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });
});
