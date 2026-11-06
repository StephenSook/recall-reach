// A saved copy of one Replay run, as one self-contained HTML file. It needs no server, so it still reads and still
// recounts with the site down. Rows are CPSC's public text and the demo shop's item titles. Nothing about a buyer or a
// PayPal record is in a run's rows.
import { matchSplitLine, OUTCOME_CHIP, ranAt, replayIntro, seconds, SPLIT_CHIP } from "@/app/replay/labels";
import type { Replay, ReplayRow } from "./replay";

export class SavedRunRefused extends Error {
  constructor(reason: string) {
    super(`This run isn't worth saving: ${reason}`);
    this.name = "SavedRunRefused";
  }
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function rowHtml(r: ReplayRow): string {
  const split = r.saleSplit ? SPLIT_CHIP[r.saleSplit] : "";
  return `<tr data-outcome="${r.outcome}"><td>${escape(r.recallNumber)}</td><td>${escape(r.recallDate)}</td><td>${escape(r.recallTitle)}</td><td>${OUTCOME_CHIP[r.outcome]}${split ? `, ${split}` : ""}</td><td>${escape(r.itemTitle ?? "")}</td><td>${escape(r.reason ?? "")}</td></tr>`;
}

const HEAD = "<thead><tr><th>Recall</th><th>Recalled</th><th>CPSC's title</th><th>Outcome</th><th>Demo shop's item</th><th>Why</th></tr></thead>";
const table = (rows: ReplayRow[], label: string) => `<div class="scroll" role="region" aria-label="${label}" tabindex="0"><table>${HEAD}<tbody>${rows.map(rowHtml).join("")}</tbody></table></div>`;

// Counts the rows on this page and compares them with the numbers it states. Runs in the reader's own browser.
const RECOUNT = `var stated = JSON.parse(document.getElementById("counts").dataset.counts);
var found = { checked: 0, MATCH: 0, SCOPE_GAP: 0, CLEARED: 0, NOT_NEAR: 0 };
document.querySelectorAll("tr[data-outcome]").forEach(function (row) { found.checked++; found[row.dataset.outcome]++; });
var agree = found.checked === stated.checked && found.MATCH === stated.matched && found.SCOPE_GAP === stated.scopeGaps && found.CLEARED === stated.cleared && found.NOT_NEAR === stated.notNear;
document.getElementById("recount").textContent = "Recounted from the rows on this page: " + found.checked + " checked, " + found.MATCH + " matched, " + found.SCOPE_GAP + " can't tell yet, " + found.CLEARED + " cleared, " + found.NOT_NEAR + " not near. " + (agree ? "They agree with the numbers above." : "They do not agree with the numbers above.");`;

const STYLE = `:root { color-scheme: light; --ink: #000; --paper: #fff; --field: #e8e8e8; --rule: #d2d2d2; --body: #4a4a4a; --gap: #ffd31e; --match: #f3670e; --clear: #84ebb4; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--field); color: var(--ink); font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.15; }
h2 { margin: 32px 0 8px; font-size: 20px; }
p { max-width: 75ch; }
.note { color: var(--body); font-size: 14px; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-block: 16px; }
.stat { padding: 10px 12px; border: 2px solid var(--ink); border-radius: 8px; background: var(--paper); }
.value { display: block; font-size: 28px; font-weight: 800; }
.label { font-size: 14px; font-weight: 600; }
.MATCH { background: var(--match); } .SCOPE_GAP { background: var(--gap); } .CLEARED { background: var(--clear); }
.scroll { overflow-x: auto; border: 2px solid var(--ink); border-radius: 8px; background: var(--paper); }
table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 14px; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
th { background: var(--field); }
details { margin-top: 16px; }
summary { cursor: pointer; font-weight: 600; padding-block: 8px; }
a { color: #002af0; }
@media (max-width: 640px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }`;

export function renderStaticReplay(replay: Replay, opts: { site: string }): string {
  const { counts, rows, runId } = replay;
  if (rows.length === 0) throw new SavedRunRefused("it has no rows");
  if (!replay.search.complete) throw new SavedRunRefused("it couldn't read all of PayPal's history");
  if (replay.recallYearsMissing.length > 0) throw new SavedRunRefused("some recall years didn't load");
  const count = (outcome: ReplayRow["outcome"]) => rows.filter((r) => r.outcome === outcome).length;
  if (rows.length !== counts.checked || count("MATCH") !== counts.matched || count("SCOPE_GAP") !== counts.scopeGaps || count("CLEARED") !== counts.cleared || count("NOT_NEAR") !== counts.notNear) {
    throw new SavedRunRefused("its rows don't add up to its numbers");
  }
  const near = rows.filter((r) => r.outcome !== "NOT_NEAR");
  const far = rows.filter((r) => r.outcome === "NOT_NEAR");
  const stated = JSON.stringify({ checked: counts.checked, matched: counts.matched, scopeGaps: counts.scopeGaps, cleared: counts.cleared, notNear: counts.notNear });
  const live = `${opts.site}/replay/${runId}`;
  const proof = `${opts.site}/api/proof/${runId}`;
  const stat = (value: number, label: string, kind = "") => `<div class="stat ${kind}"><span class="value">${value}</span> <span class="label">${label}</span></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recall Replay, saved copy</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Recall Replay</h1>
<p>A saved copy of one run. It runs nothing and needs no server, so it reads the same with the live site down.</p>
<p class="note">Run ${escape(runId)}, made ${escape(ranAt(replay.createdAt))}, ${counts.checked} recalls in ${seconds(replay.ms)} seconds. ${replayIntro(replay.recallYearsMissing)}</p>
<div class="stats" id="counts" data-counts='${stated}'>
${stat(counts.checked, "Recalls checked")}
${stat(counts.matched, "Recalls matched", "MATCH")}
${stat(counts.scopeGaps, "Can&#39;t tell yet", "SCOPE_GAP")}
${stat(counts.cleared, "Recalls cleared", "CLEARED")}
</div>
<p class="note">${escape(matchSplitLine(rows))} That split is the demo shop's, on seeded dates. ${counts.notNear} recalls had nothing near them. PayPal payments that name no item: ${counts.unidentified}.</p>
<p id="recount" role="status">Open this page with JavaScript on to recount its rows.</p>
<p class="note"><a href="${escape(live)}">This run on the live site</a> and <a href="${escape(proof)}">its recount there</a>. Those two need the live site, and a run can be pruned from it. This copy can't.</p>
<h2>What the check found</h2>
${table(near, "Recalls something came near")}
<details>
<summary>${far.length} recalls with nothing near them</summary>
${table(far, "Recalls with nothing near them")}
</details>
</main>
<script>${RECOUNT}</script>
</body>
</html>
`;
}
