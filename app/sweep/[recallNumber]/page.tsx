import Link from "next/link";
import { notFound } from "next/navigation";
import { ranAt } from "@/app/replay/labels";
import type { Recall } from "@/server/cpsc/schema";
import { getDb } from "@/server/db/pg";
import { readSweep } from "@/server/sweep/sweep";
import { sweepView } from "@/server/sweep/view";

export const dynamic = "force-dynamic";

// Reads what the hourly job cached. Opening this page never calls anyone, so a limit can't break it.
export default async function SweepPage({ params }: { params: Promise<{ recallNumber: string }> }) {
  const { recallNumber } = await params;
  const db = getDb();
  const { rows } = await db.query<Pick<Recall, "title" | "description" | "products" | "retailers"> & { url: string | null }>(
    "select title, description, products, retailers, url from recalls where recall_number = $1",
    [recallNumber],
  );
  const recall = rows[0];
  if (!recall) notFound();
  const sweep = await readSweep(db, recallNumber);
  const view = sweep?.status === "ok" ? sweepView(recall, sweep.listings) : null;
  return (
    <main className="page">
      <header className="page-head">
        <h1>On the market now</h1>
        <span className="quiet id">CPSC recall {recallNumber}</span>
      </header>
      <p>{recall.title}</p>
      {sweep && view ? (
        <>
          <p className="alert" data-testid="review-only">
            For a person to review. A same-name product may be outside this recall, and none of these is confirmed as recalled.
          </p>
          {view.candidates.length > 0 ? (
            <ul className="window cleared-list" data-testid="candidates">
              {view.candidates.map((c) => (
                <li key={c.id}>
                  <span className="chip chip-SCOPE_GAP">Review candidate</span> <strong>{c.title}</strong>
                  <span className="quiet">
                    {c.namesListedModel ? "Its title names a model CPSC lists. " : ""}
                    {c.settle.length > 0 ? `What would settle it: ${c.settle.join("; ")}` : "CPSC's notice is what would settle it."}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="no-candidates">Nothing came back with this recall&apos;s brand and product.</p>
          )}
          <p className="note" data-testid="sweep-counts">
            Searched for &quot;{sweep.query}&quot; {ranAt(sweep.searchedAt)}. {view.returned} {view.returned === 1 ? "product" : "products"} came back, and {view.notListed} {view.notListed === 1 ? "isn't" : "aren't"} this recall&apos;s brand and product, so {view.notListed === 1 ? "it isn't" : "they aren't"} named. We keep titles only, no sellers or prices.
            {sweep.recallChanged ? " CPSC has edited this recall since this search." : ""}
          </p>
        </>
      ) : (
        <p data-testid="not-searched">This recall hasn&apos;t been searched yet. A few are searched each hour.</p>
      )}
      <p className="note">
        {recall.url ? (
          <>
            <a href={recall.url}>CPSC&apos;s recall page</a>.{" "}
          </>
        ) : null}
        <Link href="/evidence/channel3">How this search works</Link>.
      </p>
      <div className="provenance">
        <span className="chip chip-real">Real CPSC</span>
        <span className="chip chip-sandbox">Channel3 search</span>
      </div>
    </main>
  );
}
