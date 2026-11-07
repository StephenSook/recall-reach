// Next.js calls register() once when the server starts. It starts the background jobs
// (server/jobs/appJobs.ts) in the Node runtime. Set JOBS_ENABLED=false to run without them.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A few seconds on one thread, so not while the host is still asking whether this server is up.
  setTimeout(() => {
    import("./server/paypal/toolkitRefund")
      .then(({ warmToolkit }) => warmToolkit())
      .catch(() => console.warn("the refund toolkit did not load ahead of time: the first refund will load it"));
  }, 15_000);
  if (process.env.JOBS_ENABLED === "false") return;
  if (!process.env.DATABASE_URL) {
    console.warn("background jobs not started: DATABASE_URL is not set");
    return;
  }
  const [{ getDb }, { appJobs }, { startScheduler }, { CHECK_FROM }, { REPLAY_FALLBACK_MS, REPLAY_FRESH_MS, refreshReplay, runReplay }, { payPalClientFromEnv }, { businessDay }, { sweepRecalls }, { channel3Search }, { DEMO_RECALL_NUMBERS }] = await Promise.all([
    import("./server/db/pg"),
    import("./server/jobs/appJobs"),
    import("./server/jobs/scheduler"),
    import("./server/match/run"),
    import("./server/replay/replay"),
    import("./server/paypal/client"),
    import("./server/time/businessDay"),
    import("./server/sweep/sweep"),
    import("./server/sweep/channel3"),
    import("./server/demo/seed"),
  ]);
  const { refreshSafety } = await import("./server/safety/attacks");
  const { agentClientFromEnv, pingClaude } = await import("./server/agent/claude");
  const claude = agentClientFromEnv();
  const shopDataKey = process.env.SHOP_DATA_KEY;
  startScheduler(
    appJobs(getDb(), {
      backfillFromYear: Number(CHECK_FROM.slice(0, 4)),
      refreshReplay: shopDataKey
        ? (at) => refreshReplay(getDb(), () => runReplay(getDb(), payPalClientFromEnv(), { today: businessDay(at), now: at, secret: shopDataKey }), at, process.env.REPLAY_VIA_WORKFLOW ? REPLAY_FALLBACK_MS : REPLAY_FRESH_MS)
        : undefined,
      refreshSafety: shopDataKey ? (at) => refreshSafety(getDb(), { now: at, secret: shopDataKey }) : undefined,
      sweepMarket: (at) => sweepRecalls(getDb(), channel3Search(), at, undefined, DEMO_RECALL_NUMBERS),
      pingClaude: claude ? (at) => pingClaude(getDb(), claude, at) : undefined,
    }),
  );
  console.info("background jobs started: cpsc-poll every 15 min; database hourly or on change, with the PayPal purge");
}
