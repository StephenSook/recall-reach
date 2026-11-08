// Run once, with sandbox credentials in the environment. No local env file or secret is written.
// pnpm exec node --import tsx scripts/subscription-plan.ts
import { payPalClientFromEnv } from "../server/paypal/client";
import { ensurePlan } from "../server/paypal/subscriptions";

ensurePlan(payPalClientFromEnv()).then((id) => console.log(`PAYPAL_SUBSCRIPTION_PLAN_ID=${id}`)).catch(() => {
  console.error("Sandbox plan setup failed. Check the sandbox app credentials and any stored plan id.");
  process.exitCode = 1;
});
