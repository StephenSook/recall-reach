import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const start = (ip = "203.0.113.7", extra: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/demo/start", { method: "POST", headers: { origin: "http://localhost", "true-client-ip": ip, ...extra } }));

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

  it("refuses a post with no Origin before anything else", async () => {
    const res = await POST(new Request("http://localhost/api/demo/start", { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("is not fooled by a different x-forwarded-for on each try", async () => {
    let last = await start("203.0.113.9", { "x-forwarded-for": "198.51.100.0" });
    for (let i = 1; i <= 10; i++) last = await start("203.0.113.9", { "x-forwarded-for": `198.51.100.${i}` });
    expect(last.headers.get("location")).toBe("http://localhost/?demo=busy");
  });

  it("caps everyone together too, so many addresses cannot spend the sandbox", async () => {
    let busy = false;
    for (let i = 0; i < 70 && !busy; i++) {
      const res = await start(`192.0.2.${i}`);
      busy = res.headers.get("location") === "http://localhost/?demo=busy";
    }
    expect(busy).toBe(true);
  });

  it("sends a visitor over the limit back to the home page too", async () => {
    let last = await start("203.0.113.8");
    for (let i = 0; i < 10; i++) last = await start("203.0.113.8");
    expect(last.status).toBe(303);
    expect(last.headers.get("location")).toBe("http://localhost/?demo=busy");
  });
});
