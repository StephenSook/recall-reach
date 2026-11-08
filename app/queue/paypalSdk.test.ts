import { afterEach, describe, expect, it, vi } from "vitest";
import { startShelfCheckout, type PayPalSdk } from "./paypalSdk";

function flow() {
  let callbacks: Parameters<PayPalSdk["createPayPalOneTimePaymentSession"]>[0];
  const start = vi.fn(async (_input, order: Promise<{ orderId: string }>) => { await order; });
  const sdk: PayPalSdk = {
    findEligibleMethods: vi.fn(),
    createPayPalOneTimePaymentSession: vi.fn((input) => { callbacks = input; return { start }; }),
  };
  const hooks = { onCaptured: vi.fn(), onCancel: vi.fn(), onError: vi.fn() };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ orderId: "ORDER-1", state: "signed-state" })).mockResolvedValue(Response.json({ captured: true }));
  return { sdk, hooks, fetchImpl, start, callbacks: () => callbacks };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the supplied v6 checkout calls", () => {
  it("starts in auto mode with the server's order promise, then captures that order on approval", async () => {
    const f = flow();
    await startShelfCheckout(f.sdk, "shelf-item", f.hooks, f.fetchImpl);
    const [path, options] = f.fetchImpl.mock.calls[0];
    expect(path).toBe("/api/demo/buy/paypal/sdk");
    expect(options?.method).toBe("POST");
    expect(String(options?.body)).toBe("shopItemId=shelf-item");
    expect(f.start).toHaveBeenCalledWith({ presentationMode: "auto" }, expect.any(Promise));
    await expect(f.start.mock.calls[0][1]).resolves.toEqual({ orderId: "ORDER-1" });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    await f.callbacks().onApprove({ orderId: "ORDER-1" });
    const [capturePath, captureOptions] = f.fetchImpl.mock.calls[1];
    expect(capturePath).toBe("/api/demo/buy/paypal/sdk/capture");
    expect(captureOptions?.method).toBe("POST");
    expect(String(captureOptions?.body)).toBe("orderId=ORDER-1&state=signed-state");
    expect(f.hooks.onCaptured).toHaveBeenCalledOnce();
    expect(f.hooks.onError).not.toHaveBeenCalled();
  });

  it("a cancel or SDK error leaves the original buy options usable, without capture", async () => {
    const f = flow();
    await startShelfCheckout(f.sdk, "item", f.hooks, f.fetchImpl);
    f.callbacks().onCancel();
    expect(f.hooks.onCancel).toHaveBeenCalledOnce();
    f.callbacks().onError();
    expect(f.hooks.onError).toHaveBeenCalledOnce();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses approval for another order", async () => {
    const f = flow();
    await startShelfCheckout(f.sdk, "item", f.hooks, f.fetchImpl);
    await f.callbacks().onApprove({ orderId: "OTHER-ORDER" });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.hooks.onError).toHaveBeenCalledOnce();
    expect(f.hooks.onCaptured).not.toHaveBeenCalled();
  });

  it("fails quietly when creation fails", async () => {
    const f = flow();
    f.fetchImpl.mockReset().mockResolvedValue(Response.json({ error: "refused" }, { status: 409 }));
    await startShelfCheckout(f.sdk, "item", f.hooks, f.fetchImpl);
    expect(f.hooks.onError).toHaveBeenCalledOnce();
    expect(f.hooks.onCaptured).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a create response without signed state", async () => {
    const f = flow();
    f.fetchImpl.mockReset().mockResolvedValue(Response.json({ orderId: "ORDER-1" }));
    await startShelfCheckout(f.sdk, "item", f.hooks, f.fetchImpl);
    expect(f.hooks.onError).toHaveBeenCalledOnce();
  });

  it("fails quietly when capture fails", async () => {
    const f = flow();
    f.fetchImpl.mockResolvedValueOnce(Response.json({ error: "refused" }, { status: 409 }));
    await startShelfCheckout(f.sdk, "item", f.hooks, f.fetchImpl);
    await f.callbacks().onApprove({ orderId: "ORDER-1" });
    expect(f.hooks.onError).toHaveBeenCalledOnce();
    expect(f.hooks.onCaptured).not.toHaveBeenCalled();
  });

  it("handles a blocked popup even when creation also fails", async () => {
    const f = flow();
    f.start.mockRejectedValue(new Error("popup blocked"));
    f.fetchImpl.mockReset().mockRejectedValue(new Error("offline"));
    await startShelfCheckout(f.sdk, "item", f.hooks, f.fetchImpl);
    expect(f.hooks.onError).toHaveBeenCalledOnce();
  });
});

describe("loading the sandbox SDK", () => {
  it("shares one exact sandbox script and instance, passing only the public client id", async () => {
    vi.resetModules();
    const sdk = flow().sdk;
    const createInstance = vi.fn().mockResolvedValue(sdk);
    const script = { src: "", async: false, onload: () => {}, onerror: () => {} };
    const appendChild = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => script), head: { appendChild } });
    vi.stubGlobal("window", { paypal: { createInstance } });
    const { loadPayPalSdk } = await import("./paypalSdk");
    const first = loadPayPalSdk("public-id");
    const second = loadPayPalSdk("public-id");
    expect(first).toBe(second);
    expect(script.src).toBe("https://www.sandbox.paypal.com/web-sdk/v6/core");
    expect(script.async).toBe(true);
    expect(appendChild).toHaveBeenCalledOnce();
    script.onload();
    expect(await first).toBe(sdk);
    expect(createInstance).toHaveBeenCalledExactlyOnceWith({ clientId: "public-id", components: ["paypal-payments"], pageType: "checkout" });
  });

  it("rejects a script load failure without creating an instance", async () => {
    vi.resetModules();
    const script = { onload: () => {}, onerror: () => {} };
    vi.stubGlobal("document", { createElement: () => script, head: { appendChild: vi.fn() } });
    const { loadPayPalSdk } = await import("./paypalSdk");
    const result = loadPayPalSdk("public-id");
    const rejected = expect(result).rejects.toThrow("PayPal did not load");
    script.onerror();
    await rejected;
  });
});
