import { getDb } from "@/server/db/pg";
import { recallPollStatus } from "@/server/jobs/appJobs";
import { createHeldReading, liveNowLine } from "@/server/judge/liveNow";

const heldReading = createHeldReading(5 * 60_000);
const MOST_WAITED_MS = 2000;

async function readLine(): Promise<string | null> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), MOST_WAITED_MS);
    });
    const poll = recallPollStatus();
    const held = await Promise.race([heldReading(getDb(), Date.now(), poll.lastPollAt), late]).finally(() => clearTimeout(timer));
    if (!held) return null;
    return liveNowLine({ checkedAt: poll.lastPollOk && poll.lastPollAt ? poll.lastPollAt : held.written, newest: held.newest, now: new Date() });
  } catch {
    return null;
  }
}

/** Real rows only. If the database can't answer quickly, the line is left out rather than guessed. */
export async function LiveNow() {
  const line = await readLine();
  return line ? <p className="note" data-testid="live-now">{line}</p> : null;
}
