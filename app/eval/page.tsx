import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { parsePairs, type EvalResults, type Rate, type scoreClaude } from "@/server/eval/score";

const read = (name: string) => readFileSync(join(process.cwd(), "eval", name), "utf8");
const percent = (r: Rate) => (r.rate === null ? "none measured" : `${(r.rate * 100).toFixed(0)}%`);
const interval = (r: Rate) => (r.low === null || r.high === null ? "" : `${(r.low * 100).toFixed(0)} to ${(r.high * 100).toFixed(0)}%`);

function Cell({ r }: { r: Rate }) {
  return (
    <td>
      <strong>
        {r.k} of {r.n}
      </strong>{" "}
      ({percent(r)})<br />
      <small>{interval(r)}</small>
    </td>
  );
}

function Bar({ label, parts }: { label: string; parts: { name: string; n: number; tone: string }[] }) {
  const total = parts.reduce((sum, p) => sum + p.n, 0);
  return (
    <figure className="bar-figure">
      <figcaption>{label}</figcaption>
      <div className="bar" role="img" aria-label={parts.map((p) => `${p.name}: ${p.n} of ${total}`).join(", ")}>
        {parts
          .filter((p) => p.n > 0)
          .map((p) => (
            <span key={p.name} className={`bar-part ${p.tone}`} style={{ flexGrow: p.n }}>
              {p.n}
            </span>
          ))}
      </div>
      <ul className="bar-legend">
        {parts.map((p) => (
          <li key={p.name}>
            <span className={`bar-swatch ${p.tone}`} /> {p.name}
          </li>
        ))}
      </ul>
    </figure>
  );
}

export default function EvalPage() {
  const results = JSON.parse(read("results.json")) as EvalResults;
  const claude = JSON.parse(read("claude-held-out.json")) as { asked: number; model: string; summary: ReturnType<typeof scoreClaude> };
  const pairs = new Map(parsePairs(read("pairs.csv")).map((p) => [p.pairId, p]));
  const { matcher, baseline } = results.heldOut;
  const negatives = matcher.falseAlarms.n;
  const named = (ids: string[]) =>
    ids.map((id) => {
      const p = pairs.get(id);
      return (
        <li key={id}>
          <span className="id">CPSC recall {p?.recallNumber}</span> {p?.title}
        </li>
      );
    });
  const weak = matcher.falseAlarms.k - matcher.couldReachFamily.k;

  return (
    <main className="page">
      <header className="page-head">
        <h1>How well it works</h1>
      </header>
      <p className="callout-result" data-testid="eval-sentence">
        On held-out recalls, when a title can&apos;t settle it, Recall Reach asks instead of guessing in {matcher.abstained.k} of {matcher.abstained.n} pairs. A plain word match guesses in {baseline.guessed.k} of {baseline.guessed.n}.
      </p>

      <Bar
        label={`${matcher.abstained.n} pairs where the title can't settle it`}
        parts={[
          { name: "Asks the family", n: matcher.abstained.k, tone: "tone-gap" },
          { name: "Calls it a match", n: matcher.guessed.k, tone: "tone-match" },
          { name: "Misses it", n: matcher.missed.k, tone: "tone-miss" },
        ]}
      />
      <Bar
        label={`${negatives} look-alikes, which are not the recalled product`}
        parts={[
          { name: "Cleared", n: negatives - matcher.falseAlarms.k, tone: "tone-clear" },
          { name: "Shown to the seller, and nothing can go out", n: weak, tone: "tone-weak" },
          { name: "A seller could message a family", n: matcher.couldReachFamily.k, tone: "tone-match" },
        ]}
      />

      <div className="window table-window">
        <table className="ledger" data-testid="eval-table">
          <thead>
            <tr>
              <th>Held-out pairs</th>
              <th>Recall Reach</th>
              <th>Word match</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A look-alike reaches the seller</td>
              <Cell r={matcher.falseAlarms} />
              <Cell r={baseline.falseAlarms} />
            </tr>
            <tr>
              <td>A look-alike could reach a family</td>
              <Cell r={matcher.couldReachFamily} />
              <Cell r={baseline.couldReachFamily} />
            </tr>
            <tr>
              <td>Title can&apos;t settle it: asks</td>
              <Cell r={matcher.abstained} />
              <Cell r={baseline.abstained} />
            </tr>
            <tr>
              <td>Title can&apos;t settle it: calls it a match</td>
              <Cell r={matcher.guessed} />
              <Cell r={baseline.guessed} />
            </tr>
            <tr>
              <td>Title can&apos;t settle it: misses it</td>
              <Cell r={matcher.missed} />
              <Cell r={baseline.missed} />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="note">Ranges are 95% Wilson intervals. Word match flags whatever the search finds, with no way to abstain.</p>

      <h2 className="section-title">What Claude says about these</h2>
      <p>Claude read the {claude.asked} held-out pairs that reach a seller. Its finding is text for the seller to read. It changes nothing above.</p>
      <p className="note" data-testid="eval-claude-caveat">Claude also wrote these labels, so this table shows it agrees with itself as much as with the truth. A person&apos;s audit is what would make it independent.</p>
      <div className="window table-window">
        <table className="ledger" data-testid="eval-claude">
          <thead>
            <tr>
              <th>Claude said</th>
              <th>On look-alikes</th>
              <th>On pairs the title can&apos;t settle</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Same product</td>
              <Cell r={claude.summary.lookAlikes.same} />
              <Cell r={claude.summary.scopeGaps.same} />
            </tr>
            <tr>
              <td>Can&apos;t tell</td>
              <Cell r={claude.summary.lookAlikes.cantTell} />
              <Cell r={claude.summary.scopeGaps.cantTell} />
            </tr>
            <tr>
              <td>Different product</td>
              <Cell r={claude.summary.lookAlikes.different} />
              <Cell r={claude.summary.scopeGaps.different} />
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className="section-title">What this does not show</h2>
      <ul className="limits">
        <li>Claude labelled all {results.pairs} pairs, from {results.recalls} recalls. One labeller, with a person&apos;s audit still to come.</li>
        <li>The titles are new retail listings. Resale titles are shorter and noisier.</li>
        <li>This set has no true matches: every title naming a recalled line still lacked what the recall&apos;s scope needs. It can&apos;t measure finding them.</li>
        <li>These are small numbers, and some titles repeat across recalls. Read the ranges.</li>
      </ul>

      <details className="window misses">
        <summary>Every miss, by name</summary>
        <h3>Could reach a family</h3>
        <ul>{named(matcher.reachFamilyPairs)}</ul>
        <h3>Missed, where the title can&apos;t settle it</h3>
        <ul>{named(matcher.missedPairs)}</ul>
        <h3>Reached the seller</h3>
        <ul>{named(matcher.falseAlarmPairs)}</ul>
      </details>

      <p className="note">
        Run it yourself with <code>pnpm eval</code>. A test fails if these numbers stop matching what the code produces. <Link href="/">Home</Link>
      </p>
    </main>
  );
}
