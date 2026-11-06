import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readRefund = vi.fn();
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT FOUND");
  },
  redirect: () => {
    throw new Error("REDIRECT");
  },
}));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/paypal/client", () => ({ payPalClientFromEnv: () => ({}) }));
vi.mock("@/server/privacy/recordKey", () => ({ recordKeyFromEnv: () => () => "key" }));
vi.mock("@/server/web/http", () => ({ currentSession: async () => ({ shopId: "s1", sessionId: "x" }) }));
vi.mock("@/server/paypal/refunds", async (original) => ({ ...(await original<object>()), readRefund: (...args: unknown[]) => readRefund(...args) }));
vi.mock("../../LookAgain", async () => {
  const { createElement: h } = await import("react");
  return { LookAgain: () => h("i", { "data-testid": "looking-again" }) };
});

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

  describe("when PayPal doesn't answer", () => {
    beforeEach(() => readRefund.mockRejectedValue(new Error("PRIVATE-DETAIL from below")));

    it("stays a page, says so, and goes on looking", async () => {
      const html = await render();
      expect(html).toContain("PayPal did not answer just now");
      expect(html).toContain('data-testid="looking-again"');
      expect(html).toContain("Back to the queue");
    });

    it("keeps what went wrong off the page and out of the log", async () => {
      const html = await render();
      expect(html).not.toContain("PRIVATE-DETAIL");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("PRIVATE-DETAIL");
    });
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

  it("leads back to the card the refund came from", async () => {
    readRefund.mockResolvedValue(record());
    expect(await render()).toContain('href="/queue#sale-m1"');
  });
});
