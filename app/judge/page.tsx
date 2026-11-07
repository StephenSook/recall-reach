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
          <strong>Catch a sale as it happens.</strong> On the bath seat&apos;s card, press Buy this as a family, and wait for it to reach the queue. PayPal can take a minute or two. With a PayPal sandbox buyer login, Buy with a PayPal sandbox login does the same on PayPal&apos;s own page.
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
      <h2 className="section-title">From an agent</h2>
      <pre data-testid="mcp-add">claude mcp add --transport http recall-reach https://recall-reach-web-e022.onrender.com/api/mcp</pre>
      <p>Two read-only tools, no key: check_recall and get_recall.</p>
      <h2 className="section-title">On a phone</h2>
      <p>
        <a href="https://github.com/StephenSook/recall-reach/releases/download/android-1.0.0/recall-reach-android-1.0.0.apk">Android build</a>, queue only. Push is iPhone only. Not tested on a device. The repository and this download are public from Nov 11.
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element -- a small static code, with nothing for the image pipeline to do */}
      <img src="/android-apk-qr.svg" alt="QR code for the Android build's download" width={160} height={160} />
      <p className="note">
        <Link href="/r/sample">What a family sees</Link>, as a sample that stays up. <Link href="/check">Check your own order file</Link>, or a Shopify store&apos;s public listings. How it uses <Link href="/evidence/paypal">PayPal</Link> and <Link href="/evidence/ag-grid">AG Grid</Link>. <Link href="/evidence/channel3">Channel3</Link>. <Link href="/evidence/api">For agents and marketplaces</Link>. <Link href="/status">Status</Link>. <Link href="/privacy">Privacy</Link>.
      </p>
    </main>
  );
}
