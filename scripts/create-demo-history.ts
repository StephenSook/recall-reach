// Makes the demo's standing PayPal history (server/demo/historyPool.ts). Sandbox only. Run it once.
// It reports counts and never prints a PayPal id.
import { HISTORY_POOL, HISTORY_POOL_MARKER } from "../server/demo/historyPool";
import { payPalClientFromEnv, PayPalApiError } from "../server/paypal/client";
import { createCardOrder } from "../server/paypal/orders";

// PayPal's sandbox accepts this test number (measured 2026-11-05). It is not a real card.
const SANDBOX_TEST_CARD = { number: "4111111111111111", expiry: "2030-12", securityCode: "123" };

async function main(): Promise<void> {
  const client = payPalClientFromEnv();
  let made = 0;
  let already = 0;
  for (const payment of HISTORY_POOL) {
    try {
      const order = await createCardOrder(client, {
        orderNumber: payment.orderNumber,
        customId: HISTORY_POOL_MARKER,
        currency: "USD",
        discountCents: 0,
        lines: payment.lines,
        amountCents: payment.amountCents,
        requestId: payment.requestId,
        card: SANDBOX_TEST_CARD,
      });
      if (order.capture?.status !== "COMPLETED") throw new Error(`capture status ${order.capture?.status ?? "missing"}`);
      made++;
    } catch (err) {
      // PayPal refuses a repeated invoice id, which here means this one already exists.
      if (err instanceof PayPalApiError && err.issue === "DUPLICATE_INVOICE_ID") already++;
      else throw err;
    }
  }
  console.log(`history pool: ${made} ready, ${already} already there, of ${HISTORY_POOL.length}, at ${new Date().toISOString()}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "unknown error");
  process.exitCode = 1;
});
