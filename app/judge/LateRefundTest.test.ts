import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fixture from "@/test/fixtures/paypal/refund-time-limit.json";
import { judgeRefusal } from "@/server/paypal/judgeRefusal";
import { REFUND_STATE } from "../queue/labels";
import { LateRefundResult } from "./LateRefundTest";

describe("the late-refund result", () => {
  const env = { NODE_ENV: "test" as const, PAYPAL_CLIENT_ID: "client", PAYPAL_CLIENT_SECRET: "secret" };
  const captureIds = async () => ["OLD-CAPTURE"];
  async function render(body: unknown, status: number) {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "token", expires_in: 300 }))
      .mockResolvedValueOnce(Response.json({ status: "REFUNDED" }))
      .mockResolvedValueOnce(Response.json(body, { status }));
    const result = await judgeRefusal({ env, captureIds, fetchImpl });
    return renderToStaticMarkup(createElement(LateRefundResult, { result })).replace(/<!-- -->/g, "");
  }

  it("renders PayPal's actual issue and description beside the existing owner mapping", async () => {
    const html = await render(fixture.body, fixture.status);
    expect(html).toContain("PayPal HTTP status: 422");
    expect(html).toContain(fixture.body.details[0].issue);
    expect(html).toContain(fixture.body.details[0].description);
    expect(html).toContain(`What the owner sees: ${REFUND_STATE.failed} (REFUND_TIME_LIMIT_EXCEEDED)`);
    expect(html).not.toMatch(/DEBUG|debug_id|OLD-CAPTURE|information_link/);
  });

  it("renders an unexpected PayPal answer as unexpected with its real words", async () => {
    const html = await render({ details: [{ issue: "CAPTURE_FULLY_REFUNDED", description: "Capture has been fully refunded." }] }, 422);
    expect(html).toContain("Unexpected answer");
    expect(html).toContain("CAPTURE_FULLY_REFUNDED");
    expect(html).toContain("Capture has been fully refunded.");
    expect(html).not.toContain("What the owner sees");
    expect(html).not.toContain("PayPal refused the late refund.");
  });
});
