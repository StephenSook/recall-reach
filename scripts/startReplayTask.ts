// Starts Replay's daily refresh on Render Workflows, from the daily GitHub Action, so the Render API key lives in a repo
// secret and not on the public web service. It doesn't wait for the run. If this never works, the web service does the
// refresh itself. Runs under `node --experimental-strip-types`, so it imports nothing.
const RENDER_TASK_RUNS = "https://api.render.com/v1/task-runs";

export async function startReplayTask(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = env.RENDER_API_KEY;
  const task = env.REPLAY_WORKFLOW_TASK;
  // Red, not a clean exit: a deleted or revoked key should show before the web service's fallback hides it.
  if (!key || !task) throw new Error("the Render key or the task's name is missing");
  const res = await fetchImpl(RENDER_TASK_RUNS, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    // No arguments, so nothing of ours is retained on Render's side.
    body: JSON.stringify({ task, input: [] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Render answered ${res.status}`);
  return "started";
}

if (process.argv[1]?.endsWith("startReplayTask.ts")) {
  startReplayTask(process.env).then(
    (outcome) => console.log(`replay task: ${outcome}`),
    (err: unknown) => {
      console.error(`replay task failed: ${err instanceof Error ? err.message : "unknown error"}`);
      process.exitCode = 1;
    },
  );
}
