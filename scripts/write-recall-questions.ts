// Asks Claude to write the question for recalls a rule can't ask anything specific about. Reads CPSC's text only.
// What it wrote is reused until CPSC changes the recall, and the day's spending cap still applies.
//   DATABASE_URL=... ANTHROPIC_API_KEY=... pnpm write:questions [--limit 20]
import { agentClientFromEnv } from "../server/agent/claude";
import { writeRecallQuestion, type QuestionStatus } from "../server/agent/recallQuestion";
import { getDb } from "../server/db/pg";

/** Every no-identifier recall the film shows, so these are written and read first. */
export const FILM_RECALLS = ["27040"];

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 20;

async function main() {
  const client = agentClientFromEnv();
  if (!client) throw new Error("ANTHROPIC_API_KEY is not set");
  const db = getDb();
  const { rows } = await db.query<{ recall_id: number }>(
    "select recall_id from recalls order by (recall_number = any($1::text[])) desc, recall_date desc, recall_number desc",
    [FILM_RECALLS],
  );
  const tally = new Map<QuestionStatus, number>();
  let asked = 0;
  for (const { recall_id: recallId } of rows) {
    if (asked >= limit) break;
    const status = await writeRecallQuestion(db, client, { recallId, now: new Date() });
    tally.set(status, (tally.get(status) ?? 0) + 1);
    if (status === "OVER_BUDGET" || status === "UNAVAILABLE") break;
    if (status === "WROTE" || status === "ABSTAINED" || status === "NO_QUESTION" || status === "REFUSED") asked++;
  }
  console.log(JSON.stringify(Object.fromEntries(tally)));
}

if (process.argv[1]?.endsWith("write-recall-questions.ts")) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
