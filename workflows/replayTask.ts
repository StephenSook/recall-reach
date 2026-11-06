// The Render Workflow task behind Replay's daily refresh. It takes no arguments and returns one word, so nothing of ours
// is kept on Render's side. A daily GitHub Action starts it (scripts/startReplayTask.ts), so no Render API key sits on the
// public web service. If it doesn't run, the web service does the refresh itself once the numbers pass 28 hours old.
import { task } from "@renderinc/sdk/workflows";
import { getDb } from "../server/db/pg";
import { payPalClientFromEnv } from "../server/paypal/client";
import { REPLAY_TASK_FRESH_MS, refreshReplay, runReplay } from "../server/replay/replay";
import { businessDay } from "../server/time/businessDay";

task({ name: "refresh_replay", timeoutSeconds: 30 * 60, retry: { maxRetries: 1, waitDurationMs: 60_000, backoffScaling: 1 } }, async function refresh_replay(): Promise<{ outcome: string }> {
  const secret = process.env.SHOP_DATA_KEY;
  if (!secret) throw new Error("SHOP_DATA_KEY is not set");
  const now = new Date();
  const outcome = await refreshReplay(getDb(), () => runReplay(getDb(), payPalClientFromEnv(), { today: businessDay(now), now, secret }), now, REPLAY_TASK_FRESH_MS);
  console.log(`refresh_replay: ${outcome}`); // one word, so Render's logs show what a run did
  return { outcome };
});
