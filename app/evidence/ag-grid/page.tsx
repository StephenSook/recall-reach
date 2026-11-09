import Link from "next/link";
import { ClaimList } from "../ClaimList";
import { AG_GRID_CLAIMS, AG_STUDIO_CLAIMS } from "../claims";

export default function AgGridEvidence() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>How it uses AG Grid</h1>
      </header>
      <p>
        AG Grid Community 36.3.0, on the <Link href="/replay">Recall Replay</Link> page, the <Link href="/eval">eval</Link> page and in the seller&apos;s queue on a wide screen. On a phone, the queue is the windows alone.
      </p>
      <ClaimList claims={AG_GRID_CLAIMS} />
      <h2>AG Studio</h2>
      <p>
        AG Studio 3.1.0 on the <Link href="/studio">recall dashboard</Link>. AG Studio trial licence, expires Dec 22. The agent reads up to 50 rows per query, so /studio holds only CPSC recalls and the shop&apos;s own catalog titles, never PayPal data.
      </p>
      <ClaimList claims={AG_STUDIO_CLAIMS} />
      <p>
        A run on this site, Nov 7, 2026, asked &quot;Show only the recalls that matched or can&apos;t tell yet&quot;. The agent counted the four outcomes (902 nothing near, 18 can&apos;t tell yet, 11 cleared, 3 matched), then added a page filter keeping Matched and Can&apos;t tell yet, in 16 turns.
      </p>
    </main>
  );
}
