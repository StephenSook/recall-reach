import type { RecallRange } from "../cpsc/fetch";

export interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
}

/**
 * Runs each job once at start, then every `everyMs`. A tick is skipped while the job's previous
 * run is still going. A failed run is logged and the schedule continues. Returns a stop function.
 */
export function startScheduler(jobs: Job[], opts: { log?: (line: string) => void } = {}): () => void {
  const log = opts.log ?? ((line: string) => console.error(line));
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const job of jobs) {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      job
        .run()
        .catch((err: unknown) => log(`job ${job.name} failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          running = false;
        });
    };
    timers.push(setTimeout(tick, 0));
    timers.push(setInterval(tick, job.everyMs));
  }
  return () => {
    for (const t of timers) clearInterval(t);
  };
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Recalls published or republished yesterday or today (UTC). CPSC's publish date has no time of day. */
export function cpscPollRange(now: Date = new Date()): RecallRange {
  return { field: "LastPublishDate", start: utcDay(new Date(now.getTime() - 86_400_000)), end: utcDay(now) };
}
