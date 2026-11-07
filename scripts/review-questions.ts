// For a person, in a terminal: read each question Claude wrote and accept or reject it. Nothing is decided for you.
// A person's accept is the only thing that lets a family's no count. A rejection may also be made on the owner's instruction.
//   pnpm review:questions [--limit 20]
// It asks for the database URL and hides it, because one pasted into a command stays in the shell's history.
import { createInterface } from "node:readline/promises";
import { pendingQuestions, reviewQuestion } from "../server/agent/questionReview";
import { getDb } from "../server/db/pg";
import { askHidden } from "./askHidden";
import { DEMO_PATH_RECALLS } from "./write-recall-questions";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 20;

async function main() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = await askHidden("Paste the database URL from the Neon console (it won't show): ", process.stdin, process.stdout);
  }
  const db = getDb();
  const pending = await pendingQuestions(db, { limit, first: DEMO_PATH_RECALLS });
  if (pending.length === 0) {
    console.log("Nothing waiting for review.");
    return;
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const tally = { ACCEPTED: 0, REJECTED: 0, skipped: 0 };
  console.log(`${pending.length} to read. Accept only if a parent could answer it by looking at the product, and Yes means it matches what CPSC describes.`);
  console.log("Reject a question that names only some of what CPSC lists.\n");
  for (const [i, q] of pending.entries()) {
    console.log(`${i + 1} of ${pending.length}. CPSC recall ${q.recallNumber}: ${q.product}`);
    console.log(`  Question:  ${q.question}`);
    console.log(`  Rests on:  "${q.evidence}"`);
    console.log(`  CPSC's description: ${q.description}`);
    console.log(`  ${q.url}`);
    const answer = (await terminal.question("  [a]ccept, [r]eject, [s]kip, [q]uit: ")).trim().toLowerCase();
    if (answer === "q") break;
    if (answer !== "a" && answer !== "r") {
      tally.skipped++;
      console.log("");
      continue;
    }
    const decision = answer === "a" ? "ACCEPTED" : "REJECTED";
    // A separate decision, because this is what lets a No tell a family theirs does not match.
    let scopeConfirmed = false;
    if (decision === "ACCEPTED" && q.everyRecalledUnit) {
      const scope = await terminal.question("  Claude says every recalled unit has this. Does CPSC's text say so? A yes lets a No tell a family theirs doesn't match. [y/N]: ");
      scopeConfirmed = scope.trim().toLowerCase() === "y";
    }
    const saved = await reviewQuestion(db, { recallNumber: q.recallNumber, question: q.question, decision, scopeConfirmed });
    if (saved) tally[decision]++;
    console.log(saved ? `  ${decision.toLowerCase()}\n` : "  Not saved: this question has changed or was already decided.\n");
  }
  terminal.close();
  console.log(`Accepted ${tally.ACCEPTED}, rejected ${tally.REJECTED}, skipped ${tally.skipped}.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
