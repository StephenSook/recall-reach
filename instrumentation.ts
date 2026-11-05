// Next.js calls register() once when the server starts. It starts the background jobs
// (server/jobs/appJobs.ts) in the Node runtime. Set JOBS_ENABLED=false to run without them.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.JOBS_ENABLED === "false") return;
  if (!process.env.DATABASE_URL) {
    console.warn("background jobs not started: DATABASE_URL is not set");
    return;
  }
  const [{ getDb }, { appJobs }, { startScheduler }] = await Promise.all([
    import("./server/db/pg"),
    import("./server/jobs/appJobs"),
    import("./server/jobs/scheduler"),
  ]);
  startScheduler(appJobs(getDb()));
  console.info("background jobs started: cpsc-poll every 15 min; database hourly or on change, with the PayPal purge");
}
