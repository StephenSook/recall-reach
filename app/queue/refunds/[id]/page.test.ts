import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readRefund = vi.fn();
const clientFromEnv = vi.fn(() => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT FOUND");
  },
  redirect: () => {
    throw new Error("REDIRECT");
  },
}));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/paypal/client", async (original) => ({ ...(await original<object>()), payPalClientFromEnv: () => clientFromEnv() }));
vi.mock("@/server/privacy/recordKey", () => ({ recordKeyFromEnv: () => () => "key" }));
vi.mock("@/server/web/http", () => ({ currentSession: async () => ({ shopId: "s1", sessionId: "x" }) }));
vi.mock("@/server/paypal/refunds", async (original) => ({ ...(await original<object>()), readRefund: (...args: unknown[]) => readRefund(...args) }));
vi.mock("../../LookAgain", async () => {
  const { createElement: h } = await import("react");
  return { LookAgain: () => h("i", { "data-testid": "looking-again" }) };
});

import { PayPalApiError } from "@/server/paypal/client";
import { RefundRefused } from "@/server/paypal/refunds";
import RefundPage from "./page";

const render = async () => renderToStaticMarkup(createElement("div", null, await RefundPage({ params: Promise.resolve({ id: "r1" }) })));
const record = (over: object = {}) => ({
  matchId: "m1",
  canAskAgain: false,
  stuck: null,
  newerAnswer: null,
  ledger: { status: "refunded", amountCents: 9000, currency: "USD" },
  capture: { status: "REFUNDED", amountCents: 9000, currency: "USD" },
  refund: { status: "COMPLETED", amountCents: 9000, currency: "USD" },
  webhook: { seen: false },
  exceptions: [],
  ...over,
});

describe("the refund page", () => {
  const logged = vi.fn();
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(logged));
  afterEach(() => {
    vi.restoreAllMocks();
    readRefund.mockReset();
    logged.mockReset();
  });

  describe("when the records can't be read", () => {
    it("stays a page, says so without blaming anyone, and goes on looking", async () => {
      readRefund.mockRejectedValue(new Error("PRIVATE-DETAIL from below"));
      const html = await render();
      expect(html).toContain("The records can&#x27;t be read just now");
      expect(html).not.toContain("PayPal did not answer");
      expect(html).toContain('data-testid="looking-again"');
      expect(html).toContain("Back to the queue");
    });

    it("logs what kind of failure it was, and never what an unknown error says", async () => {
      readRefund.mockRejectedValue(new TypeError("PRIVATE-DETAIL from below"));
      const html = await render();
      expect(html).not.toContain("PRIVATE-DETAIL");
      expect(logged).toHaveBeenCalledWith("refund page could not read its records:", "TypeError");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("PRIVATE-DETAIL");
    });

    it("logs PayPal's own answer, whose message is written for logs", async () => {
      readRefund.mockRejectedValue(new PayPalApiError(503, "GET", "/v2/payments/refunds/PRIVATE-ID"));
      await render();
      expect(logged).toHaveBeenCalledWith("refund page could not read its records:", "PayPal 503 on GET /v2/payments/refunds/:id");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("PRIVATE-ID");
    });
  });

  it("doesn't pass off a missing setting as a passing failure", async () => {
    clientFromEnv.mockImplementationOnce(() => {
      throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
    });
    await expect(render()).rejects.toThrow("must be set");
  });

  it("still says not found for a refund that isn't this shop's", async () => {
    readRefund.mockRejectedValue(new RefundRefused("NO_SUCH_REFUND" as never, "no"));
    await expect(render()).rejects.toThrow("NOT FOUND");
  });

  it("looks again only while the webhook hasn't come", async () => {
    readRefund.mockResolvedValue(record());
    expect(await render()).toContain('data-testid="looking-again"');
    readRefund.mockResolvedValue(record({ webhook: { seen: true } }));
    expect(await render()).not.toContain('data-testid="looking-again"');
    readRefund.mockResolvedValue(record({ ledger: { status: "failed", amountCents: 9000, currency: "USD" } }));
    expect(await render()).not.toContain('data-testid="looking-again"');
  });

  it("with a dispute on the payment, never tells the owner to refund it by hand", async () => {
    readRefund.mockResolvedValue(record({ stuck: { orderNumber: "#1", sentToPayPal: false, disputed: true } }));
    const page = (await render()).replace(/<!-- -->/g, "");
    expect(page).toContain("settle the dispute there and don&#x27;t refund it by hand");
    expect(page).not.toContain("refund it there");
    readRefund.mockResolvedValue(record({ stuck: { orderNumber: "#1", sentToPayPal: false, disputed: false } }));
    expect((await render()).replace(/<!-- -->/g, "")).toContain("If no refund shows, refund it there.");
  });

  it("says what the page does", async () => {
    readRefund.mockResolvedValue(record());
    expect(await render()).toContain("<h1>Refund, checked against PayPal</h1>");
  });

  it("leads back to the card the refund came from", async () => {
    readRefund.mockResolvedValue(record());
    expect(await render()).toContain('href="/queue#sale-m1"');
  });
});
