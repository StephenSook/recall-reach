import { describe, expect, it, vi } from "vitest";
import type { PayPalClient } from "./client";
import { askPayPalToVerify, verifyRequestBody } from "./webhookCheck";
import type { TransmissionHeaders } from "./webhooks";

const headers: TransmissionHeaders = {
  transmissionId: "T-1",
  transmissionTime: "2026-11-07T23:00:00Z",
  transmissionSig: "c2ln",
  certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  authAlgo: "SHA256withRSA",
};
// Spacing, key order and an escaped character, all of which a parse and re-serialize would change.
const RAW = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.REFUNDED","resource":{"note":"caf\\u00e9"}}\n';
const bytes = new TextEncoder().encode(RAW);

const clientAnswering = (answer: unknown) => {
  const request = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    if (answer === "hang") return new Promise<never>(() => {});
    return { status: 200, data: answer };
  });
  return { client: { request } as unknown as PayPalClient, request };
};

describe("PayPal's own check of a webhook delivery", () => {
  it("puts the event in the request exactly as PayPal sent it, byte for byte", () => {
    const text = verifyRequestBody(headers, "WEBHOOK-9", RAW);
    expect(text).toContain(`"webhook_event":${RAW}`);
    expect(JSON.parse(text)).toMatchObject({ auth_algo: "SHA256withRSA", cert_url: headers.certUrl, transmission_id: "T-1", transmission_sig: "c2ln", transmission_time: headers.transmissionTime, webhook_id: "WEBHOOK-9" });
    expect(JSON.parse(text).webhook_event).toEqual(JSON.parse(RAW));
  });

  it("asks PayPal's verify-webhook-signature with that text and reads its answer", async () => {
    const { client, request } = clientAnswering({ verification_status: "SUCCESS" });
    expect(await askPayPalToVerify(client, headers, "WEBHOOK-9", bytes)).toBe("SUCCESS");
    expect(request).toHaveBeenCalledWith("POST", "/v1/notifications/verify-webhook-signature", { rawJson: verifyRequestBody(headers, "WEBHOOK-9", RAW) });
  });

  it("says FAILURE when PayPal does", async () => {
    expect(await askPayPalToVerify(clientAnswering({ verification_status: "FAILURE" }).client, headers, "WEBHOOK-9", bytes)).toBe("FAILURE");
  });

  it.each([
    ["an error", new Error("HTTP 500")],
    ["an answer it can't read", { verification_status: "MAYBE" }],
    ["no answer within the time allowed", "hang"],
  ])("says PayPal couldn't be asked on %s, never a pass", async (_name, answer) => {
    expect(await askPayPalToVerify(clientAnswering(answer).client, headers, "WEBHOOK-9", bytes, 20)).toBe("UNAVAILABLE");
  });

  it("doesn't ask without every header PayPal needs", async () => {
    const { client, request } = clientAnswering({ verification_status: "SUCCESS" });
    expect(await askPayPalToVerify(client, { ...headers, transmissionSig: undefined }, "WEBHOOK-9", bytes)).toBe("UNAVAILABLE");
    expect(request).not.toHaveBeenCalled();
  });
});
