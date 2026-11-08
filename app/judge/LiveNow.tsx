import { getDb } from "@/server/db/pg";
import { recallPollStatus } from "@/server/jobs/appJobs";
import { lastGoodPull, liveNowLine, newestRecall } from "@/server/judge/liveNow";

async function readLine(): Promise<string | null> {
  try {
    const db = getDb();
    const poll = recallPollStatus();
    const [newest, written] = await Promise.all([newestRecall(db), lastGoodPull(db)]);
    return liveNowLine({ checkedAt: poll.lastPollOk && poll.lastPollAt ? poll.lastPollAt : written, newest, now: new Date() });
  } catch {
    return null;
  }
}

/** Real rows only. If the database can't answer, the line is left out rather than guessed. */
export async function LiveNow() {
  const line = await readLine();
  return line ? <p className="note" data-testid="live-now">{line}</p> : null;
}
