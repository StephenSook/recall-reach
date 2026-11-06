import Link from "next/link";
import { StartDemoButton } from "../StartDemoButton";

export default function JudgeDoor() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>Three minutes, no login</h1>
      </header>
      <p>Real CPSC recalls and real PayPal sandbox payments, on a demo shop made just for you.</p>
      <StartDemoButton />
      <ol className="window cleared-list" data-testid="itinerary">
        <li>
          <strong>Tell a family.</strong> Open the card for recall 27072, press Approve this notice, then open it in mail and follow its link to the family&apos;s page.
        </li>
        <li>
          <strong>Refund a sale made after a recall.</strong> On the card for recall 27027, press Review refund, then the refund button, then Check it against PayPal.
        </li>
        <li>
          <strong>Catch a sale as it happens.</strong> On the bath seat&apos;s card, press Buy this as a family, and wait for it to reach the queue.
        </li>
        <li>
          <strong>See the refund windows.</strong> In the queue, open a sale&apos;s row, then Why this came up, then Refund windows.
        </li>
        <li>
          <strong>Ask what a recall needs.</strong> On the card for recall 27040, press Approve this check request and answer on the family&apos;s page.
        </li>
        <li>
          <strong>See it stay quiet.</strong> <Link href="/replay">Recall Replay</Link> runs every recall from 2025 on, and you can recount it. <Link href="/eval">The eval</Link> has held-out numbers beside a word-match baseline.
        </li>
        <li>
          <strong>Try to break it.</strong> <Link href="/safety">The safety checks</Link> try five attacks on the real code.
        </li>
      </ol>
      <h2 className="section-title">From a terminal</h2>
      <pre data-testid="curl">{`curl https://recall-reach-web-e022.onrender.com/api/health
curl "https://recall-reach-web-e022.onrender.com/api/recalls/today/matches?shop=demo"
curl "https://recall-reach-web-e022.onrender.com/api/check?title=Baby%20Brezza%20sterilizer&model=BRZ0083"`}</pre>
      <p className="note">
        <Link href="/check">Check your own order file</Link>. How it uses <Link href="/evidence/paypal">PayPal</Link> and <Link href="/evidence/ag-grid">AG Grid</Link>. <Link href="/evidence/channel3">Channel3</Link>. <Link href="/evidence/api">For agents and marketplaces</Link>. <Link href="/privacy">Privacy</Link>.
      </p>
    </main>
  );
}
