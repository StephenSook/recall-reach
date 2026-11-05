import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCertFetcher,
  isTrustedCertUrl,
  readTransmissionHeaders,
  signedMessage,
  verifyWebhook,
  type TransmissionHeaders,
} from "./webhooks";

// A throwaway key pair stands in for PayPal's signing certificate. Nothing here is a real credential.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const WEBHOOK_ID = "TEST-WEBHOOK-ID";
const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test";

const event = { id: "WH-TEST-1", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "TEST-REFUND-1" } };
const body = Buffer.from(JSON.stringify(event));

function signedHeaders(raw: Buffer, webhookId = WEBHOOK_ID): TransmissionHeaders {
  const transmissionId = "0f3c9b10-test";
  const transmissionTime = "2026-11-05T20:00:00Z";
  const signer = createSign("sha256WithRSAEncryption");
  signer.update(signedMessage(transmissionId, transmissionTime, webhookId, raw));
  return {
    transmissionId,
    transmissionTime,
    transmissionSig: signer.sign(privateKey).toString("base64"),
    certUrl: CERT_URL,
    authAlgo: "SHA256withRSA",
  };
}

function certFrom(pem: string) {
  const calls: string[] = [];
  const fetchCert = async (url: string) => {
    calls.push(url);
    return pem;
  };
  return { calls, fetchCert };
}

describe("signedMessage", () => {
  it("joins id, time, webhook id and the CRC32 of the raw body in decimal", () => {
    // CRC32("hello") = 0x3610a686 = 907060870
    expect(signedMessage("t-id", "t-time", "wh-id", Buffer.from("hello"))).toBe("t-id|t-time|wh-id|907060870");
  });
});

describe("isTrustedCertUrl", () => {
  it("accepts PayPal sandbox certificate URLs", () => {
    expect(isTrustedCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1")).toBe(true);
    expect(isTrustedCertUrl("https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1")).toBe(true);
  });

  it("refuses live PayPal hosts (this app is sandbox only)", () => {
    expect(isTrustedCertUrl("https://api.paypal.com/v1/notifications/certs/CERT-1")).toBe(false);
    expect(isTrustedCertUrl("https://api-m.paypal.com/v1/notifications/certs/CERT-1")).toBe(false);
  });

  it("refuses look-alike hosts, plain http, other paths, ports and credentials", () => {
    for (const url of [
      "https://evil.example/v1/notifications/certs/CERT-1",
      "https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-1",
      "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "https://api.sandbox.paypal.com/v1/other/CERT-1",
      "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1",
      "https://user@api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1?x=1",
      "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1?",
      "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1#frag",
      "https://api.sandbox.paypal.com/v1/notifications/certs/..%2f..%2f..%2fv1%2foauth2%2ftoken",
      "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1/extra",
      "https://api.sandbox.paypal.com/v1/notifications/certs/",
      "not a url",
    ]) {
      expect(isTrustedCertUrl(url), url).toBe(false);
    }
  });
});

describe("readTransmissionHeaders", () => {
  it("reads the paypal-* transmission headers", () => {
    const h = new Headers({
      "paypal-transmission-id": "a",
      "paypal-transmission-time": "b",
      "paypal-transmission-sig": "c",
      "paypal-cert-url": "d",
      "paypal-auth-algo": "e",
    });
    expect(readTransmissionHeaders(h)).toEqual({
      transmissionId: "a",
      transmissionTime: "b",
      transmissionSig: "c",
      certUrl: "d",
      authAlgo: "e",
    });
  });
});

describe("verifyWebhook", () => {
  it("verifies a correctly signed event and returns it parsed", async () => {
    const cert = certFrom(PUBLIC_PEM);
    const result = await verifyWebhook(body, signedHeaders(body), WEBHOOK_ID, cert);
    expect(result).toEqual({ verified: true, event });
    expect(cert.calls).toEqual([CERT_URL]);
  });

  it("rejects the event when one byte of the body changed", async () => {
    const tampered = Buffer.from(JSON.stringify({ ...event, id: "WH-TEST-2" }));
    const result = await verifyWebhook(tampered, signedHeaders(body), WEBHOOK_ID, certFrom(PUBLIC_PEM));
    expect(result).toMatchObject({ verified: false, reason: expect.stringMatching(/signature/) });
  });

  it("rejects an event signed for a different webhook id", async () => {
    const result = await verifyWebhook(body, signedHeaders(body, "OTHER-ID"), WEBHOOK_ID, certFrom(PUBLIC_PEM));
    expect(result.verified).toBe(false);
  });

  it("rejects an event signed by a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
    const result = await verifyWebhook(body, signedHeaders(body), WEBHOOK_ID, certFrom(other.toString()));
    expect(result.verified).toBe(false);
  });

  it("refuses an untrusted certificate URL without fetching it", async () => {
    const cert = certFrom(PUBLIC_PEM);
    const headers = { ...signedHeaders(body), certUrl: "https://evil.example/v1/notifications/certs/CERT-1" };
    const result = await verifyWebhook(body, headers, WEBHOOK_ID, cert);
    expect(result).toMatchObject({ verified: false, reason: expect.stringMatching(/certificate URL/) });
    expect(cert.calls).toEqual([]);
  });

  it("rejects a delivery with a missing transmission header", async () => {
    const headers = { ...signedHeaders(body), transmissionSig: undefined };
    const result = await verifyWebhook(body, headers, WEBHOOK_ID, certFrom(PUBLIC_PEM));
    expect(result).toMatchObject({ verified: false, reason: expect.stringMatching(/header/) });
  });

  it("rejects an auth algorithm other than SHA256withRSA", async () => {
    const headers = { ...signedHeaders(body), authAlgo: "SHA1withRSA" };
    const result = await verifyWebhook(body, headers, WEBHOOK_ID, certFrom(PUBLIC_PEM));
    expect(result).toMatchObject({ verified: false, reason: expect.stringMatching(/algorithm/) });
  });

  it("rejects correctly signed bytes that are not a webhook event", async () => {
    const notEvent = Buffer.from(JSON.stringify({ hello: "world" }));
    const result = await verifyWebhook(notEvent, signedHeaders(notEvent), WEBHOOK_ID, certFrom(PUBLIC_PEM));
    expect(result).toMatchObject({ verified: false, reason: expect.stringMatching(/event/) });
  });

  it("returns not verified (never throws) when the certificate cannot be fetched", async () => {
    const fetchCert = async () => {
      throw new Error("HTTP 503");
    };
    const result = await verifyWebhook(body, signedHeaders(body), WEBHOOK_ID, { fetchCert });
    expect(result).toMatchObject({ verified: false, reason: expect.stringMatching(/HTTP 503/) });
  });
});

describe("createCertFetcher", () => {
  it("downloads a certificate once and serves it from cache afterwards", async () => {
    let downloads = 0;
    const fetchImpl = async () => {
      downloads++;
      return new Response(PUBLIC_PEM, { status: 200 });
    };
    const fetchCert = createCertFetcher(fetchImpl as typeof fetch);
    expect(await fetchCert(CERT_URL)).toBe(PUBLIC_PEM);
    expect(await fetchCert(CERT_URL)).toBe(PUBLIC_PEM);
    expect(downloads).toBe(1);
  });

  it("does not cache a failed download", async () => {
    let downloads = 0;
    const fetchImpl = async () => {
      downloads++;
      return downloads === 1 ? new Response("no", { status: 503 }) : new Response(PUBLIC_PEM, { status: 200 });
    };
    const fetchCert = createCertFetcher(fetchImpl as typeof fetch);
    await expect(fetchCert(CERT_URL)).rejects.toThrow(/HTTP 503/);
    expect(await fetchCert(CERT_URL)).toBe(PUBLIC_PEM);
  });

  it("refuses a redirect instead of following it", async () => {
    let redirectMode: RequestRedirect | undefined;
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response(PUBLIC_PEM, { status: 200 });
    };
    await createCertFetcher(fetchImpl as unknown as typeof fetch)(CERT_URL);
    expect(redirectMode).toBe("error");
  });

  it("does not cache a download that is not a usable public key", async () => {
    let downloads = 0;
    const fetchImpl = async () => {
      downloads++;
      return downloads === 1
        ? new Response("-----BEGIN NONSENSE-----\nabc\n-----END NONSENSE-----", { status: 200 })
        : new Response(PUBLIC_PEM, { status: 200 });
    };
    const fetchCert = createCertFetcher(fetchImpl as typeof fetch);
    await expect(fetchCert(CERT_URL)).rejects.toThrow(/not a usable/);
    expect(await fetchCert(CERT_URL)).toBe(PUBLIC_PEM);
    expect(downloads).toBe(2);
  });

  it("refuses an oversized certificate download", async () => {
    const huge = "-----BEGIN PUBLIC KEY-----\n" + "A".repeat(200_000);
    const fetchCert = createCertFetcher((async () => new Response(huge, { status: 200 })) as unknown as typeof fetch);
    await expect(fetchCert(CERT_URL)).rejects.toThrow(/too large/);
  });

  it("refuses to download from an untrusted URL", async () => {
    const fetchCert = createCertFetcher((async () => new Response(PUBLIC_PEM)) as unknown as typeof fetch);
    await expect(fetchCert("https://evil.example/cert")).rejects.toThrow(/certificate URL/);
  });
});
