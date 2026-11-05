import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const start = (ip = "203.0.113.7") =>
  POST(new Request("http://localhost/api/demo/start", { method: "POST", headers: { origin: "http://localhost", "x-forwarded-for": ip } }));

describe("POST /api/demo/start", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", ""); // setup fails before any PayPal call
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends a failed setup back to the home page with a message, not to a bare error body", async () => {
    const res = await start();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/?demo=failed");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sends a visitor over the limit back to the home page too", async () => {
    let last = await start("203.0.113.8");
    for (let i = 0; i < 10; i++) last = await start("203.0.113.8");
    expect(last.status).toBe(303);
    expect(last.headers.get("location")).toBe("http://localhost/?demo=busy");
  });
});
