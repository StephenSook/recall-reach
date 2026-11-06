import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/demo/start on the host", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("makes nothing when it cannot tell who is asking, rather than sharing one bucket", async () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "https://app.example");
    vi.stubEnv("DATABASE_URL", "");
    const res = await POST(new Request("https://app.example/api/demo/start", { method: "POST", headers: { origin: "https://app.example" } }));
    expect(res.headers.get("location")).toBe("https://app.example/?demo=busy");
  });
});
