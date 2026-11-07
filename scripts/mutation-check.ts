// Breaks one guard at a time in a throwaway copy of the code and runs the test that should notice. A guard whose break no test
// catches is a guard nothing protects. Run by hand: pnpm exec tsx scripts/mutation-check.ts. It changes nothing in this checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Plant {
  about: string;
  file: string;
  find: string;
  put: string;
  test: string;
}

const REFUNDS = "server/paypal/refunds.test.ts";
const VERDICT = "server/match/verdict.test.ts";
const SHOPPER = "server/agent/shopper.test.ts";
const ORDER = "server/paypal/shopperOrder.test.ts";
const PAYOUTS = "server/paypal/payouts.test.ts";

export const PLANTS: Plant[] = [
  { about: "a recorded dispute no longer stops a repeat", file: "server/paypal/refunds.ts", find: "if (row.dispute_seen_at) throw disputedAgain();", put: "", test: REFUNDS },
  { about: "a dispute seen while checking no longer stops the send", file: "server/paypal/refunds.ts", find: "and repeat_refused_at is null and dispute_seen_at is null", put: "and repeat_refused_at is null", test: REFUNDS },
  { about: "a repeat no longer waits for a send in progress", file: "server/paypal/refunds.ts", find: 'if (row.send_lease_until && row.send_lease_until.getTime() > now.getTime()) throw new RefundRefused("REFUND_BEING_SENT"', put: 'if (false) throw new RefundRefused("REFUND_BEING_SENT"', test: REFUNDS },
  { about: "any code no longer stops a confirm by look", file: "server/match/verdict.ts", find: "nearMissCode.length === 0 && !carriesCode", put: "nearMissCode.length === 0", test: VERDICT },
  { about: "a near-miss beside the exact model no longer stops a confirm", file: "server/match/verdict.ts", find: "if (shown.length > 0 && nearMissCode.length > 0) {", put: "if (false) {", test: VERDICT },
  { about: "a SKU holding the model is exempt again", file: "server/match/verdict.ts", find: "return rest.includes(n) || (n.length >= 6 && longestRun(rest, n).length / n.length >= 0.8);", put: "return false;", test: VERDICT },
  { about: "a limited recall can be confirmed by its model", file: "server/match/verdict.ts", find: "if (shown.length > 0 && limited) {", put: "if (false) {", test: VERDICT },
  { about: "digits alone count as a shared code", file: "server/match/verdict.ts", find: 'run.length >= 4 && /[A-Z]/.test(run) &&', put: "run.length >= 4 &&", test: VERDICT },
  { about: "a prepared notice can be a question nobody approved", file: "server/notice/store.ts", find: 'if (input.onlyIfMatch && kind !== "SAFETY_NOTICE") throw', put: "if (false) throw", test: "server/notice/standing.test.ts" },
  { about: "an answered second notice stays ready", file: "server/notice/store.ts", find: "subject: n.second_prepared_at && !n.responded_at ?", put: "subject: n.second_prepared_at ?", test: "server/notice/standing.test.ts" },
  { about: "the model can see a listing over budget", file: "server/agent/shopper.ts", find: "found.filter((l) => l.priceCents <= input.budgetCents)", put: "found", test: SHOPPER },
  { about: "a listing can be offered unchecked", file: "server/agent/shopper.ts", find: 'if (!checked) return fail(ourText("Check that listing with check_recall first."));', put: 'if (!checked) return { content: toolResult(ourText("Offered.")), end: done("PICKED", { listing, recallsChecked: 0, from: null, similar: 0 }) };', test: SHOPPER },
  { about: "a flagged listing can be offered", file: "server/agent/shopper.ts", find: 'if (checked.result !== "NO_MATCH_FOUND") return fail', put: "if (false) return fail", test: SHOPPER },
  { about: "a price in a title reaches the model", file: "server/agent/sources.ts", find: 'listing.title.replace(PRICE_IN_WORDS, " ")', put: "listing.title", test: SHOPPER },
  { about: "a moved price no longer stops the order", file: "server/paypal/shopperOrder.ts", find: "if (cartHash(live) !== slip.cart_hash) throw", put: "if (false) throw", test: ORDER },
  { about: "a slip works more than once", file: "server/paypal/shopperOrder.ts", find: "where id = $1 and used_at is null and expires_at > $2::timestamptz returning", put: "where id = $1 returning", test: ORDER },
  { about: "the way back reads PayPal for any order", file: "server/paypal/shopperOrder.ts", find: 'if (!slip?.order_ref_hmac || slip.order_ref_hmac !== input.recordKey("paypal-resource", input.orderId)) throw notPaid();', put: "if (!slip) throw notPaid();", test: ORDER },
  { about: "an old confirmation can send a newer amount", file: "server/paypal/payouts.ts", find: "and request_id = $5::uuid and status = 'reviewed'", put: "and $5::uuid is not null and status = 'reviewed'", test: PAYOUTS },
  { about: "a stale answer can undo a final one", file: "server/paypal/payouts.ts", find: "and ${STATUS_RANK} <= $3`", put: "and $3::int is not null`", test: PAYOUTS },
];

function main(): number {
  const root = process.cwd();
  const copy = mkdtempSync(join(tmpdir(), "recall-reach-mutation-"));
  try {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    for (const file of tracked) if (existsSync(join(root, file))) cpSync(join(root, file), join(copy, file), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
    execFileSync("git", ["init", "-q"], { cwd: copy });
    execFileSync("git", ["add", "-A"], { cwd: copy });
    let survived = 0;
    for (const plant of PLANTS) {
      const path = join(copy, plant.file);
      const original = readFileSync(path, "utf8");
      if (!original.includes(plant.find)) {
        console.log(`NOT FOUND  ${plant.about}`);
        survived++;
        continue;
      }
      writeFileSync(path, original.replace(plant.find, plant.put));
      const run = spawnSync("pnpm", ["exec", "vitest", "run", plant.test], { cwd: copy, encoding: "utf8" });
      writeFileSync(path, original);
      const caught = run.status !== 0;
      console.log(`${caught ? "caught    " : "NOT CAUGHT"} ${plant.about}`);
      if (!caught) survived++;
    }
    console.log(`${PLANTS.length - survived} of ${PLANTS.length} caught`);
    return survived === 0 ? 0 : 1;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("mutation-check.ts")) process.exit(main());
