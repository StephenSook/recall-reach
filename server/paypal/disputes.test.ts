import { describe, expect, it } from "vitest";
import { createPayPalClient, PayPalApiError, type PayPalClient } from "./client";
import { disputeOnCapture } from "./disputes";

const clientAnswering = (data: unknown, seen: unknown[] = []): PayPalClient => ({
  request: (async (_method: string, path: string, opts?: { query?: Record<string, string> }) => {
    seen.push({ path, query: opts?.query });
    return { status: 200, data };
  }) as PayPalClient["request"],
});

describe("reading PayPal's disputes on a capture", () => {
  it("asks about this capture and no other", async () => {
    const seen: unknown[] = [];
    await disputeOnCapture(clientAnswering({ items: [] }, seen), "CAPTURE123");
    expect(seen).toEqual([{ path: "/v1/customer/disputes", query: { disputed_transaction_id: "CAPTURE123", page_size: "50" } }]);
  });

  it("goes through the real client's path check", async () => {
    const seen: string[] = [];
    const tokens = { get: async () => "t", invalidate: () => {} };
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url));
      return Response.json({ items: [] });
    }) as typeof fetch;
    const client = createPayPalClient({ tokens, fetchImpl } as Parameters<typeof createPayPalClient>[0]);
    await expect(disputeOnCapture(client, "CAPTURE123")).resolves.toBe("NONE");
    expect(new URL(seen[0]).search).toBe("?disputed_transaction_id=CAPTURE123&page_size=50");
  });

  it("won't put anything but a PayPal id in the request", async () => {
    await expect(disputeOnCapture(clientAnswering({ items: [] }), "X&start_time=2020")).resolves.toBe("UNREADABLE");
  });

  it.each([
    ["no disputes", { items: [] }, "NONE"],
    ["no disputes, with PayPal's links to this page", { items: [], links: [{ rel: "self" }, { rel: "first" }] }, "NONE"],
    ["an open dispute", { items: [{ status: "OPEN" }] }, "DISPUTED"],
    ["one waiting on the seller", { items: [{ status: "WAITING_FOR_SELLER_RESPONSE" }] }, "DISPUTED"],
    ["one under review", { items: [{ status: "UNDER_REVIEW" }] }, "DISPUTED"],
    // PayPal may already have paid the buyer back on a resolved dispute, and the list doesn't say who won.
    ["a resolved dispute", { items: [{ status: "RESOLVED" }] }, "DISPUTED"],
    ["a status this app has never seen", { items: [{ status: "SOMETHING_NEW" }] }, "DISPUTED"],
    ["a dispute with no status", { items: [{}] }, "DISPUTED"],
  ])("%s", async (_name, data, expected) => {
    await expect(disputeOnCapture(clientAnswering(data), "CAPTURE123")).resolves.toBe(expected);
  });

  it("can't call an answer clear when PayPal says there's another page", async () => {
    await expect(disputeOnCapture(clientAnswering({ items: [], links: [{ rel: "next" }] }), "CAPTURE123")).resolves.toBe("UNREADABLE");
  });

  it.each([
    ["an answer with no list of disputes", {}],
    ["an answer of another shape", { items: "none" }],
    ["items that aren't objects", { items: ["x"] }],
    ["a null answer", null],
  ])("calls %s unreadable, never clear", async (_name, data) => {
    await expect(disputeOnCapture(clientAnswering(data), "CAPTURE123")).resolves.toBe("UNREADABLE");
  });

  it.each([
    ["a refusal", new PayPalApiError(403, "GET", "/v1/customer/disputes")],
    ["a server error", new PayPalApiError(500, "GET", "/v1/customer/disputes")],
    ["a dropped connection", new Error("ECONNRESET")],
  ])("calls %s unreadable, never clear", async (_name, err) => {
    const failing: PayPalClient = {
      request: (async () => {
        throw err;
      }) as PayPalClient["request"],
    };
    await expect(disputeOnCapture(failing, "CAPTURE123")).resolves.toBe("UNREADABLE");
  });
});
