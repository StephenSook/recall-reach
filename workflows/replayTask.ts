// The Render Workflow task behind Replay's daily refresh. It takes no arguments and returns one word, so nothing of ours
// is kept on Render's side. A daily GitHub Action starts it (scripts/startReplayTask.ts), so no Render API key sits on the
// public web service. If it doesn't run, the web service does the refresh itself once the numbers pass 26 hours old.
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { getDb } from "../server/db/pg";
import { payPalClientFromEnv } from "../server/paypal/client";
import { REPLAY_TASK_FRESH_MS, refreshReplay, runReplay } from "../server/replay/replay";
import { recordTaskRun } from "../server/replay/taskRuns";
import { businessDay } from "../server/time/businessDay";

// Every run writes a row in replay_task_runs, fresh or not, so a start of this task can be checked from our own database.
task({ name: "refresh_replay", timeoutSeconds: 30 * 60, retry: { maxRetries: 1, waitDurationMs: 60_000, backoffScaling: 1 } }, async function refresh_replay(ctx: TaskContext): Promise<{ outcome: string }> {
  const db = getDb();
  const outcome = await recordTaskRun(
    db,
    async () => {
      const secret = process.env.SHOP_DATA_KEY;
      if (!secret) throw new Error("SHOP_DATA_KEY is not set");
      const now = new Date();
      return refreshReplay(db, () => runReplay(db, payPalClientFromEnv(), { today: businessDay(now), now, secret }), now, REPLAY_TASK_FRESH_MS);
    },
    { taskRunId: ctx.metadata.taskRunId, now: () => new Date() },
  );
  console.log(`refresh_replay: ${outcome}`); // one word, so Render's logs show what a run did
  return { outcome };
});
