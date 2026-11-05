import type { RecallRange } from "../cpsc/fetch";

export interface Job {
  name: string;
  everyMs: number;
  /** How long a run may hold the job before it is released and logged. Defaults to everyMs. */
  deadlineMs?: number;
  run: () => Promise<void>;
}

/**
 * Runs each job once at start, then every `everyMs`. A tick is skipped while the job's previous run
 * is still going, and logged once if that outlasts the interval. A run past its deadline is released
 * and logged so a stalled query cannot stop a job for the life of the process (the query itself is
 * bounded by the pool's timeouts). A failed run is logged and the schedule continues. Returns stop.
 */
export function startScheduler(
  jobs: Job[],
  opts: { log?: (line: string) => void; now?: () => number } = {},
): () => void {
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? Date.now;
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const job of jobs) {
    const deadlineMs = job.deadlineMs ?? job.everyMs;
    let current = 0; // which run holds the job; 0 means none
    let runs = 0;
    let startedAt = 0;
    let warned = false;
    const tick = () => {
      if (current !== 0) {
        if (!warned && now() - startedAt > job.everyMs) {
          warned = true;
          log(`job ${job.name} still running after ${Math.floor((now() - startedAt) / 1000)} s; skipping ticks`);
        }
        return;
      }
      const id = ++runs;
      current = id;
      startedAt = now();
      warned = false;
      const release = () => {
        if (current === id) current = 0;
      };
      const deadline = setTimeout(() => {
        if (current === id) {
          release();
          log(`job ${job.name} exceeded its ${deadlineMs} ms deadline; released`);
        }
      }, deadlineMs);
      job
        .run()
        .catch((err: unknown) => log(`job ${job.name} failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          clearTimeout(deadline);
          release();
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
