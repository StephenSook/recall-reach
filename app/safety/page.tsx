import { ranAt } from "@/app/replay/labels";
import { RunAgainButton } from "@/app/replay/RunAgainButton";
import { getDb } from "@/server/db/pg";
import { latestSafetyRun, type AttackOutcome } from "@/server/safety/attacks";
import { TESTED_BY } from "./testedBy";
import { TrickCheck } from "./TrickCheck";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  busy: "These have been run a lot in the last hour. Try again in a while.",
  failed: "The checks could not run just now. Please try again.",
};
const OUTCOME: Record<AttackOutcome, string> = { REFUSED: "Refused", LET_THROUGH: "Let through", NOT_RUN: "Did not run" };

export default async function SafetyPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const message = typeof error === "string" && Object.hasOwn(MESSAGES, error) ? MESSAGES[error] : null;
  const run = await latestSafetyRun(getDb());
  return (
    <main className="page">
      <header className="page-head">
        <h1>Safety checks</h1>
        {run ? (
          <span className="quiet" data-testid="safety-clock">
            {run.results.filter((r) => r.outcome === "REFUSED").length} of {run.results.length} refused, in {(run.ms / 1000).toFixed(1)} seconds
          </span>
        ) : null}
      </header>
      <p>Five things that must be refused, tried against the code the shop uses.</p>
      {message ? (
        <p role="alert" className="alert">
          {message}
        </p>
      ) : null}
      <div className="actions">
        <RunAgainButton action="/api/safety/run" label={run ? "Run them again" : "Run them"} />
      </div>
      {run ? (
        <section data-testid="safety-results">
          {run.results.map((r) => (
            <article key={r.id} className="window" data-attack={r.id} data-outcome={r.outcome}>
              <header className="window-bar">
                <span className="id">{r.title}</span>
                <span className="chips">
                  <span className="chip">{OUTCOME[r.outcome]}</span>
                </span>
              </header>
              <div className="window-body">
                <p>{r.tried}</p>
                <p className="quiet">{r.detail}</p>
                {TESTED_BY[r.id] ? (
                  <p className="quiet" data-testid="tested-by">
                    Test: <code>{TESTED_BY[r.id].file}</code>, &quot;{TESTED_BY[r.id].test}&quot;
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      ) : null}
      <TrickCheck />
      <p className="note">
        PayPal and the model are stand-ins here, so a check never moves sandbox money or spends anything. The webhook check, the refund rules, the agent&apos;s tools and the matcher are the real code, on throwaway shops that are deleted afterwards. {run ? `Run ${ranAt(run.ranAt)}.` : null}
      </p>
      <div className="provenance">
        <span className="chip chip-real">Real CPSC</span>
        <span className="chip chip-sandbox">Stand-in PayPal</span>
        <span className="chip chip-sandbox">Demo shop</span>
      </div>
    </main>
  );
}
