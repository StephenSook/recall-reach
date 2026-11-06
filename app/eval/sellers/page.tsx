import Link from "next/link";
import { getDb } from "@/server/db/pg";
import { sellerTally, type SellerTally } from "@/server/match/sellerAnswers";

export const dynamic = "force-dynamic";

async function readTally(): Promise<SellerTally | null> {
  try {
    return await sellerTally(getDb());
  } catch (err) {
    console.error("seller tally failed:", err instanceof Error ? err.name : "unknown error");
    return null;
  }
}

export default async function SellerAnswersPage() {
  const tally = await readTally();
  return (
    <main className="page">
      <header className="page-head">
        <h1>What sellers said</h1>
      </header>
      <p>
        A seller can say whether a flagged item is the recalled product. Each answer is re-run through today&apos;s matcher when this page loads. Only shops using their own file or store address count, never a demo shop. This shows counts only, never a shop, a title or a recall.
      </p>
      {!tally ? (
        <p role="alert" className="alert">
          The answers could not be read just now.
        </p>
      ) : tally.answers === 0 ? (
        <p data-testid="seller-tally">No shop using its own file or address has answered yet.</p>
      ) : (
        <ul className="limits" data-testid="seller-tally">
          <li>
            {tally.answers} {tally.answers === 1 ? "answer" : "answers"}: {tally.sameProduct} said it&apos;s the recalled product, {tally.differentProduct} said it&apos;s different.
          </li>
          <li>The matcher today agrees with {tally.matcherAgrees} of them.</li>
          <li>It still raises {tally.stillRaised} the seller said are different.</li>
          <li>It clears {tally.nowCleared} the seller said are the recalled product.</li>
        </ul>
      )}
      <p className="note">
        Anyone can upload a file, and nobody checked these answers. They aren&apos;t in the held-out numbers on <Link href="/eval">the eval page</Link>, and they change no card.
      </p>
    </main>
  );
}
