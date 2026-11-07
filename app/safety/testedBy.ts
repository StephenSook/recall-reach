/** The test in the repo that pins each check, apart from the page's own run of it. A test fails if one of these stops existing. */
export const TESTED_BY: Record<string, { file: string; test: string }> = {
  "injected-title": { file: "server/agent/recallAgent.test.ts", test: "treats what a listing says as data: an instruction in a title gets it no further" },
  "forged-webhook": { file: "server/paypal/webhookHandler.test.ts", test: "answers 401 to a forged delivery and stores nothing" },
  "replayed-refund": { file: "server/paypal/refunds.test.ts", test: "consumes an approval once: a replay is refused and moves no money" },
  "past-180-days": { file: "server/paypal/refunds.test.ts", test: "refuses past 180 days from the payment" },
  "near-miss": { file: "server/match/verdict.test.ts", test: "CLEARED: same brand, a different product" },
};
