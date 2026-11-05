import type { FetchDeps } from "../cpsc/fetch";
import { pullRecalls } from "../cpsc/pull";
import type { Db } from "../db/types";
import { purgePayPalData } from "../privacy/retention";
import { cpscPollRange, type Job } from "./scheduler";

export const CPSC_POLL_MS = 15 * 60_000;
export const PURGE_MS = 60 * 60_000;

/** The background jobs the server runs: the CPSC poll and the PayPal 48-hour purge. */
export function appJobs(db: Db, deps: FetchDeps & { now?: () => Date } = {}): Job[] {
  const now = deps.now ?? (() => new Date());
  return [
    {
      name: "cpsc-poll",
      everyMs: CPSC_POLL_MS,
      run: async () => {
        const s = await pullRecalls(db, cpscPollRange(now()), deps);
        console.info(
          `cpsc-poll ${s.range.start}..${s.range.end}: ${s.status}, fetched ${s.fetched}, ` +
            `inserted ${s.inserted}, updated ${s.updated}, invalid ${s.invalid.length}`,
        );
      },
    },
    {
      name: "paypal-48h-purge",
      everyMs: PURGE_MS,
      run: async () => {
        const deleted = await purgePayPalData(db, now());
        console.info(`paypal-48h-purge: deleted ${JSON.stringify(deleted)}`);
      },
    },
  ];
}
