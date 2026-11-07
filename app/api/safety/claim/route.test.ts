import { describe, expect, it } from "vitest";
import { POST } from "./route";

const asking = (body: string) => new Request("http://localhost/api/safety/claim", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "true-client-ip": "198.51.100.7" }, body });

describe("POST /api/safety/claim", () => {
  it("refuses a body far larger than a claim needs, unread", async () => {
    const res = await POST(asking(JSON.stringify({ quote: "a".repeat(10_000) })));
    expect(res.status).toBe(413);
  });
});
