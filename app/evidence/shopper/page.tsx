import Link from "next/link";
import { ranAt } from "@/app/replay/labels";
import { getDb } from "@/server/db/pg";
import { latestExampleRun, type ExampleRun } from "@/server/shopper/exampleRuns";

export const dynamic = "force-dynamic";

const money = (cents: number) => `${(cents / 100).toFixed(2)} USD`;

const CHECKED: Record<string, string> = {
  NAMES_A_RECALL: "a recall names it, so it can't be offered",
  NO_MATCH_FOUND: "no recall held here names it",
  COULD_NOT_FINISH: "the check couldn't finish, so it can't be offered",
};

/** Whether the run's offer was paid. A payment is claimed only when PayPal's order read back as completed. */
export function paymentLine(run: Pick<ExampleRun, "pick" | "paidAt" | "offerExpiresAt">, now: number): string {
  if (!run.pick) return "It offered nothing, so there was nothing to pay.";
  if (run.paidAt) return `Paid on PayPal's page ${ranAt(run.paidAt)}, in the sandbox, once PayPal's order read back as completed.`;
  if (run.offerExpiresAt && Date.parse(run.offerExpiresAt) > now) return `Not yet paid. The offer is open until ${ranAt(run.offerExpiresAt)}.`;
  return `Not yet paid. The offer ran out ${run.offerExpiresAt ? ranAt(run.offerExpiresAt) : ""} unpaid: an offer lasts 10 minutes, and a person pays on PayPal's page.`.replace("  ", " ");
}

/** The newest recorded run, and when it was read, so the page says whether its offer is still open. */
async function load(): Promise<{ run: ExampleRun | null; readAt: number }> {
  const readAt = Date.now();
  try {
    return { run: await latestExampleRun(getDb()), readAt };
  } catch {
    return { run: null, readAt };
  }
}

export default async function ShopperEvidence() {
  const { run, readAt } = await load();
  return (
    <main className="page">
      <header className="page-head">
        <h1>A recorded run of the shopping agent</h1>
      </header>
      <p>
        One real run of the <Link href="/shopper">shopping agent</Link>, on one of its own examples, kept as it happened. Claude searched public listings through Channel3, checked each one it might offer against the CPSC recalls held here, and offered one. A person pays on PayPal&apos;s page, in the sandbox. Claude can&apos;t pay, never sees a price, and is sent nothing PayPal returns.
      </p>
      {!run ? (
        <p data-testid="no-run">No run has been recorded yet.</p>
      ) : (
        <>
          <p data-testid="run-meta">
            <span className="chip chip-real">Recorded run</span> {ranAt(run.ranAt)}. Asked for &quot;{run.ask}&quot;, budget {money(run.budgetCents)}. Answered by {run.models.length > 0 ? run.models.join(", then ") : "no model"}.
          </p>
          <h2 className="section-title">What it did</h2>
          <ol data-testid="run-steps">
            {run.steps.map((step, i) =>
              step.kind === "search" ? (
                <li key={i}>
                  Searched for &quot;{step.query}&quot;: {step.found} listings, {step.inBudget} in budget.
                </li>
              ) : (
                <li key={i}>
                  Checked &quot;{step.title}&quot;: {CHECKED[step.result] ?? step.result}
                  {step.recalls.length > 0 ? (
                    <>
                      {" "}
                      (
                      {step.recalls.map((n, j) => (
                        <span key={n}>
                          {j > 0 ? ", " : ""}
                          <Link href={`/recall/${n}`}>recall {n}</Link>
                        </span>
                      ))}
                      )
                    </>
                  ) : null}
                  .
                </li>
              ),
            )}
          </ol>
          {run.blocked.length > 0 ? (
            <>
              <h2 className="section-title">What it couldn&apos;t offer</h2>
              <ul data-testid="run-blocked">
                {run.blocked.map((b) => (
                  <li key={b.title}>
                    {b.title}, {money(b.priceCents)}. Named by{" "}
                    {b.recalls.map((r, j) => (
                      <span key={r.number}>
                        {j > 0 ? ", " : ""}
                        <Link href={`/recall/${r.number}`}>recall {r.number}</Link>
                      </span>
                    ))}
                    .
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h2 className="section-title">What it offered</h2>
          {run.pick ? (
            <p data-testid="run-pick">
              {run.pick.title}
              {run.pick.brand ? `, by ${run.pick.brand}` : ""}, {money(run.pick.priceCents)}. Checked against {run.pick.recallsChecked.toLocaleString("en-US")} CPSC recalls
              {run.pick.from ? ` since ${run.pick.from}` : ""}.
              {run.pick.similar > 0 ? ` ${run.pick.similar} recalls of the same kind of product named neither its maker nor its model.` : ""}
            </p>
          ) : (
            <p data-testid="run-pick">Nothing.</p>
          )}
          <p data-testid="run-payment">{paymentLine(run, readAt)}</p>
        </>
      )}
      <p className="note">
        <Link href="/evidence/channel3">How it uses Channel3</Link>. <Link href="/judge">Back</Link>
      </p>
    </main>
  );
}
