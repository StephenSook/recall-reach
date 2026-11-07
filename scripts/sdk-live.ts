// The APIMatic-generated SDK in sdk/typescript, against the deployed site. Three calls, each checked. Reads only.
//   pnpm exec tsx scripts/sdk-live.ts
import { RecallReachPublicApiClient } from "../sdk/typescript/src/index";

async function main(): Promise<number> {
  const client = new RecallReachPublicApiClient({});
  const failed: string[] = [];
  const match = await client.check.checkRecall({ title: "Baby Brezza sterilizer", model: "BRZ0083" });
  console.log(`checkRecall BRZ0083: ${match.results[0]?.recallNumber} ${match.results[0]?.verdict}, ${match.checked.recalls} recalls read`);
  if (match.results[0]?.recallNumber !== "27072" || match.results[0]?.verdict !== "MATCH") failed.push("BRZ0083 should name recall 27072 as a match");
  const maker = await client.check.checkRecall({ title: "Bodum" });
  const named = [...maker.results, ...maker.mentioned.recalls].map((r) => r.recallNumber);
  console.log(`checkRecall Bodum: ${named.slice(0, 3).join(", ")}`);
  if (!named.includes("27055")) failed.push("Bodum should name recall 27055");
  const health = await client.status.health();
  console.log(`health: ok ${health.ok}, PayPal ${health.paypal?.environment}`);
  if (health.paypal?.environment !== "sandbox") failed.push("health should say sandbox");
  for (const f of failed) console.log(`FAIL ${f}`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
