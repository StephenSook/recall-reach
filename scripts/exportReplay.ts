// Saves one Replay run as a page that needs no server: docs/replay/index.html, published with GitHub Pages.
//   pnpm exec tsx scripts/exportReplay.ts <runId> [https://site]
// It reads the run from the live site, so it holds exactly what that page shows.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Replay } from "../server/replay/replay";
import { renderStaticReplay } from "../server/replay/staticPage";

const SITE = "https://recall-reach-web-e022.onrender.com";

async function main(): Promise<void> {
  const [runId, site = SITE] = process.argv.slice(2);
  if (!runId) throw new Error("usage: exportReplay <runId> [site]");
  const res = await fetch(`${site}/api/replay/${runId}`);
  if (!res.ok) throw new Error(`the site answered ${res.status} for that run`);
  const replay = (await res.json()) as Replay;
  mkdirSync("docs/replay", { recursive: true });
  writeFileSync("docs/replay/index.html", renderStaticReplay(replay, { site: SITE }));
  console.log(`saved run ${runId}: ${replay.counts.checked} recalls, ${replay.counts.matched} matched, ${replay.counts.scopeGaps} can't tell yet, ${replay.counts.cleared} cleared, ${replay.counts.notNear} not near`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "export failed");
  process.exitCode = 1;
});
