// For a person, in a terminal: read each question Claude wrote and accept or reject it. Nothing is decided for you.
//   DATABASE_URL=... pnpm review:questions [--limit 20]
import { createInterface } from "node:readline/promises";
import { pendingQuestions, reviewQuestion } from "../server/agent/questionReview";
import { getDb } from "../server/db/pg";
import { FILM_RECALLS } from "./write-recall-questions";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 20;

async function main() {
  const db = getDb();
  const pending = await pendingQuestions(db, { limit, first: FILM_RECALLS });
  if (pending.length === 0) {
    console.log("Nothing waiting for review.");
    return;
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const tally = { ACCEPTED: 0, REJECTED: 0, skipped: 0 };
  console.log(`${pending.length} to read. Accept only if a parent could answer it by looking at the product, and Yes means it matches what CPSC describes.\n`);
  for (const [i, q] of pending.entries()) {
    console.log(`${i + 1} of ${pending.length}. CPSC recall ${q.recallNumber}: ${q.product}`);
    console.log(`  Question:  ${q.question}`);
    console.log(`  CPSC says: "${q.evidence}"`);
    console.log(`  Every recalled unit has this, according to Claude: ${q.everyRecalledUnit ? "yes, so a No would count" : "no, so a No stays can't tell"}`);
    console.log(`  ${q.url}`);
    const answer = (await terminal.question("  [a]ccept, [r]eject, [s]kip, [q]uit: ")).trim().toLowerCase();
    if (answer === "q") break;
    if (answer !== "a" && answer !== "r") {
      tally.skipped++;
      console.log("");
      continue;
    }
    const decision = answer === "a" ? "ACCEPTED" : "REJECTED";
    const saved = await reviewQuestion(db, { recallNumber: q.recallNumber, question: q.question, decision });
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
