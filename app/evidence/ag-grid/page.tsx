import Link from "next/link";
import { ClaimList } from "../ClaimList";
import { AG_GRID_CLAIMS } from "../claims";

export default function AgGridEvidence() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>How it uses AG Grid</h1>
      </header>
      <p>
        AG Grid Community 36.2.0, on the <Link href="/replay">Recall Replay</Link> page and in the seller&apos;s queue on a wide screen. On a phone, the queue is the windows alone.
      </p>
      <ClaimList claims={AG_GRID_CLAIMS} />
    </main>
  );
}
