import Link from "next/link";
import { getDb } from "@/server/db/pg";
import { sweepCounts } from "@/server/sweep/sweep";
import { ClaimList } from "../ClaimList";
import { CHANNEL3_CLAIMS } from "../claims";

export const dynamic = "force-dynamic";

async function counts() {
  try {
    return await sweepCounts(getDb());
  } catch {
    return null; // the page still says what it does
  }
}

export default async function Channel3Evidence() {
  const sweep = await counts();
  return (
    <main className="page">
      <header className="page-head">
        <h1>How it uses Channel3</h1>
      </header>
      <p>A recall names a product, not a listing. Channel3 is how a recall gets from a product name to what the market lists under it.</p>
      <ClaimList claims={CHANNEL3_CLAIMS} />
      {sweep ? (
        <p className="note" data-testid="sweep-totals">
          {sweep.searched} recalls searched so far, and {sweep.listings} products came back.
        </p>
      ) : null}
      <h2 className="section-title">What this does not show</h2>
      <p>That any recalled unit is still for sale. A same-name product may be outside the recall, and how fresh the index is hasn&apos;t been checked. So a result is only ever a candidate for a person to review.</p>
      <h2 className="section-title">What goes out</h2>
      <p>Only the product name from CPSC&apos;s public record. Nothing from a shop or from PayPal is sent.</p>
      <p className="note">
        <Link href="/sweep/27072">See one recall</Link>. <Link href="/evidence/shopper">A recorded run of the shopping agent</Link>. <Link href="/judge">Back</Link>
      </p>
      <div className="provenance">
        <span className="chip chip-real">Real CPSC</span>
        <span className="chip chip-sandbox">Channel3 search</span>
      </div>
    </main>
  );
}
