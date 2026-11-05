import { describe, expect, it } from "vitest";
import { readCappedBody } from "./body";

/** A request whose body arrives in `chunks` pieces of `size` bytes, counting how many were pulled. */
function streamedRequest(chunks: number, size: number, headers: Record<string, string> = {}) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  const request = new Request("http://localhost/hook", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { request, pulled: () => pulled };
}

describe("readCappedBody", () => {
  it("returns the whole body when it fits", async () => {
    const res = await readCappedBody(new Request("http://localhost/hook", { method: "POST", body: "hello" }), 10);
    expect(res.ok).toBe(true);
    expect(res.ok && Buffer.from(res.body).toString()).toBe("hello");
  });

  it("accepts a body of exactly the limit", async () => {
    const { request } = streamedRequest(2, 5);
    const res = await readCappedBody(request, 10);
    expect(res.ok && res.body.byteLength).toBe(10);
  });

  it("refuses without reading when Content-Length is over the limit", async () => {
    const { request, pulled } = streamedRequest(100, 1000, { "content-length": "100000" });
    const res = await readCappedBody(request, 10_000);
    expect(res.ok).toBe(false);
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("stops reading as soon as a streamed body passes the limit", async () => {
    const { request, pulled } = streamedRequest(1000, 1000);
    const res = await readCappedBody(request, 5_000);
    expect(res.ok).toBe(false);
    expect(pulled()).toBeLessThan(10);
  });

  it("returns an empty body for a request with none", async () => {
    const res = await readCappedBody(new Request("http://localhost/hook", { method: "POST" }), 10);
    expect(res.ok && res.body.byteLength).toBe(0);
  });
});
