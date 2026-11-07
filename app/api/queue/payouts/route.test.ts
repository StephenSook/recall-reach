import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as { shopId: string; sessionId: string } | null }));
vi.mock("@/server/web/http", async (original) => ({ ...(await original<typeof import("@/server/web/http")>()), currentSession: async () => session.current, secret: () => "k".repeat(32) }));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/paypal/client", async (original) => ({ ...(await original<typeof import("@/server/paypal/client")>()), payPalClientFromEnv: () => ({}) }));
vi.mock("@/server/privacy/recordKey", () => ({ recordKeyFromEnv: () => () => "hash" }));
const paths = vi.hoisted(() => ({ review: vi.fn(), send: vi.fn(), read: vi.fn() }));
vi.mock("@/server/paypal/payouts", async (original) => ({
  ...(await original<typeof import("@/server/paypal/payouts")>()),
  reviewPayout: paths.review,
  sendPayout: paths.send,
  readPayoutFromPayPal: paths.read,
}));

import { PayoutRefused } from "@/server/paypal/payouts";
import { POST } from "./route";

const post = (fields: Record<string, string>, origin = "http://localhost") =>
  POST(new Request("http://localhost/api/queue/payouts", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));

describe("POST /api/queue/payouts", () => {
  let shop = 0;
  beforeEach(() => {
    session.current = { shopId: `shop-${++shop}`, sessionId: "s" };
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("DEMO_PAYOUT_RECEIVER", "buyer@personal.example.com");
    for (const fn of Object.values(paths)) {
      fn.mockReset();
      fn.mockResolvedValue({});
    }
  });

  it("pays only the demo's sandbox buyer, whatever the form says", async () => {
    await post({ action: "review", email: "someone@else.example", amount: "1.00" });
    expect(paths.review.mock.calls[0][1]).toMatchObject({ email: "buyer@personal.example.com" });
  });

  it("reviews nothing if no sandbox buyer is set up", async () => {
    vi.stubEnv("DEMO_PAYOUT_RECEIVER", "");
    const res = await post({ action: "review", amount: "1.00" });
    expect(paths.review).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("message")).toBe("This demo has no sandbox buyer set up for this payment.");
  });

  it("needs a shop's session", async () => {
    session.current = null;
    expect((await post({ action: "review" })).status).toBe(401);
    expect(paths.review).not.toHaveBeenCalled();
  });

  it("must come from a page on this site", async () => {
    expect((await post({ action: "send", payoutId: "p" }, "https://elsewhere.example")).status).toBe(401);
    expect(paths.send).not.toHaveBeenCalled();
  });

  it("reviewing sends nothing", async () => {
    await post({ action: "review", email: "a@b.co", amount: "1.00" });
    expect(paths.review).toHaveBeenCalledOnce();
    expect(paths.send).not.toHaveBeenCalled();
  });

  it("takes the shop from the session, whatever the form says", async () => {
    await post({ action: "send", payoutId: "p", shopId: "someone-elses" });
    expect(paths.send.mock.calls[0][2]).toMatchObject({ shopId: session.current?.shopId, payoutId: "p" });
  });

  it("limits how many a shop can send", async () => {
    for (let i = 0; i < 3; i++) await post({ action: "send", payoutId: "p" });
    await post({ action: "send", payoutId: "p" });
    expect(paths.send).toHaveBeenCalledTimes(3);
  });

  it("passes a refusal's words back", async () => {
    paths.review.mockRejectedValue(new PayoutRefused("BAD_EMAIL", "Enter the email the shop collected for this buyer."));
    const res = await post({ action: "review" });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("message")).toBe("Enter the email the shop collected for this buyer.");
  });

  it("refuses what it doesn't know", async () => {
    expect((await post({ action: "other" })).status).toBe(400);
  });
});
