// Before a test runs against a deployed site, wait until /api/health names the build that should be live. Right after a
// push the old build keeps answering for a while, and a check run then passes for code it never saw. Set EXPECT_BUILD to
// the short commit; against a deployed site the run refuses to start without it.
import type { FullConfig } from "@playwright/test";

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/** Returns how many reads it took (0 for a local server). Throws if the build never answers. */
export async function waitForBuild(opts: {
  base: string;
  want: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  tries?: number;
}): Promise<number> {
  if (LOCAL.test(opts.base)) return 0;
  const want = opts.want?.trim();
  if (!want) throw new Error(`Set EXPECT_BUILD to the short commit that should be live on ${opts.base}, so this run can't pass on an older build.`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tries = opts.tries ?? 60;
  let last = "no answer";
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetchImpl(`${opts.base.replace(/\/$/, "")}/api/health`, { cache: "no-store" });
      const build = res.ok ? ((await res.json()) as { build?: string | null }).build ?? null : null;
      last = build ?? `HTTP ${res.status}`;
      if (build === want) return i;
    } catch {
      last = "no answer";
    }
    if (i < tries) await sleep(10_000);
  }
  throw new Error(`The deployed site never answered as build ${want}: the last answer was ${last}.`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL ?? "";
  const reads = await waitForBuild({ base, want: process.env.EXPECT_BUILD });
  if (reads > 0) console.log(`build ${process.env.EXPECT_BUILD} answered on ${base}`);
}
