// Only the v6 calls in PayPal's supplied example notes. These local types describe that subset.
export interface PayPalSdk {
  findEligibleMethods(input: { currencyCode: "USD" }): Promise<{ isEligible(method: "paypal"): boolean }>;
  createPayPalOneTimePaymentSession(input: {
    onApprove(data: { orderId: string }): Promise<void>;
    onCancel(): void;
    onError(): void;
  }): { start(input: { presentationMode: "auto" }, order: Promise<{ orderId: string }>): Promise<void> };
}

interface PayPalCore {
  createInstance(input: { clientId: string; components: ["paypal-payments"]; pageType: "checkout" }): Promise<PayPalSdk>;
}

export const PAYPAL_CORE_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";
let core: Promise<PayPalCore> | undefined;
const instances = new Map<string, Promise<PayPalSdk>>();

/** One script and instance across shelf cards, including React's repeated effect setup. */
export function loadPayPalSdk(clientId: string): Promise<PayPalSdk> {
  core ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PAYPAL_CORE_URL;
    script.async = true;
    script.onload = () => {
      const paypal = (window as Window & { paypal?: PayPalCore }).paypal;
      if (paypal) resolve(paypal);
      else reject(new Error("PayPal did not load"));
    };
    script.onerror = () => reject(new Error("PayPal did not load"));
    document.head.appendChild(script);
  });
  let sdk = instances.get(clientId);
  if (!sdk) {
    sdk = core.then((paypal) => paypal.createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" }));
    instances.set(clientId, sdk);
  }
  return sdk;
}

/** Each click owns its signed checkout state. An approval must name that same order. */
export async function startShelfCheckout(sdk: PayPalSdk, shopItemId: string, callbacks: {
  onCaptured(): void;
  onCancel(): void;
  onError(): void;
}, fetchImpl: typeof fetch = fetch): Promise<void> {
  let checkout: { orderId: string; state: string } | undefined;
  const session = sdk.createPayPalOneTimePaymentSession({
    onApprove: async ({ orderId }) => {
      try {
        if (!checkout || orderId !== checkout.orderId) throw new Error("Unexpected order");
        const response = await fetchImpl("/api/demo/buy/paypal/sdk/capture", {
          method: "POST", body: new URLSearchParams({ orderId, state: checkout.state }),
        });
        if (!response.ok) throw new Error("PayPal capture failed");
        callbacks.onCaptured();
      } catch {
        callbacks.onError();
      }
    },
    onCancel: callbacks.onCancel,
    onError: callbacks.onError,
  });
  const createOrderPromise = (async () => {
    const response = await fetchImpl("/api/demo/buy/paypal/sdk", {
      method: "POST", body: new URLSearchParams({ shopItemId }),
    });
    if (!response.ok) throw new Error("PayPal order failed");
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("orderId" in data) || typeof data.orderId !== "string" ||
      !("state" in data) || typeof data.state !== "string") throw new Error("Unexpected checkout response");
    checkout = { orderId: data.orderId, state: data.state };
    return { orderId: checkout.orderId };
  })();
  // Handle a failed order even if opening the popup fails before the SDK consumes the promise.
  void createOrderPromise.catch(() => {});
  try {
    await session.start({ presentationMode: "auto" }, createOrderPromise);
  } catch {
    callbacks.onError();
  }
}
