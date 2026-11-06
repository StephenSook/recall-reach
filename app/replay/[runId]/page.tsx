import { notFound } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { loadReplay } from "@/server/replay/replay";
import { matchSplitLine, OUTCOME_CHIP, seconds } from "../labels";
import { ReplayGridLoader } from "../ReplayGridLoader";
import { RunAgainButton } from "../RunAgainButton";

export const dynamic = "force-dynamic";

export default async function ReplayPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const replay = await loadReplay(getDb(), runId);
  if (!replay) notFound();
  const { counts, search } = replay;
  const found = replay.rows.filter((r) => r.outcome === "MATCH" || r.outcome === "SCOPE_GAP");
  return (
    <main className="page">
      <header className="page-head">
        <h1>Recall Replay</h1>
        <span className="quiet" data-testid="clock">
          {counts.checked} recalls in {seconds(replay.ms)} seconds
        </span>
      </header>
      <p>Every real CPSC recall we hold, checked against the demo shop in one run.</p>
      <div className="stats" data-testid="replay-counts">
        <div className="stat">
          <span className="stat-value">{counts.checked}</span>
          <span className="stat-label">Recalls checked</span>
        </div>
        <div className="stat stat-MATCH">
          <span className="stat-value">{counts.matched}</span>
          <span className="stat-label">Matched</span>
        </div>
        <div className="stat stat-SCOPE_GAP">
          <span className="stat-value">{counts.scopeGaps}</span>
          <span className="stat-label">Scope gaps</span>
        </div>
        <div className="stat stat-CLEARED">
          <span className="stat-value">{counts.cleared}</span>
          <span className="stat-label">Cleared</span>
        </div>
      </div>
      <p className="note" data-testid="replay-split">
        {matchSplitLine(replay.rows)} That split is the demo shop&apos;s, on seeded dates.{" "}
        {counts.unidentified} {counts.unidentified === 1 ? "payment" : "payments"} couldn&apos;t be identified. {counts.notNear} recalls had nothing near them.
      </p>
      <p className="note">
        {search.complete ? `PayPal's search read all ${search.windows} windows.` : `PayPal's search failed for ${search.failedWindows} of ${search.windows} windows.`} PayPal can take up to 3 hours to list a sale and keeps 3 years. Run at {replay.createdAt.slice(0, 16).replace("T", " ")} UTC.{" "}
        <a href={`/api/proof/${replay.runId}`}>Recount these numbers</a>.
      </p>
      <div className="actions">
        <RunAgainButton />
      </div>
      <ReplayGridLoader rows={replay.rows} />
      <section className="narrow-only">
        <h2 className="section-title">What it found</h2>
        <ul className="window cleared-list" data-testid="replay-found">
          {found.map((r) => (
            <li key={r.recallNumber}>
              <span className="id">CPSC recall {r.recallNumber}</span> <span className={`chip chip-${r.outcome}`}>{OUTCOME_CHIP[r.outcome]}</span> <strong>{r.itemTitle}</strong>
              <span className="quiet">{r.reason}</span>
            </li>
          ))}
        </ul>
      </section>
      <div className="provenance">
        <span className="chip chip-real">Real CPSC</span>
        <span className="chip chip-sandbox">Sandbox PayPal</span>
        <span className="chip chip-sandbox">Demo shop</span>
      </div>
    </main>
  );
}
