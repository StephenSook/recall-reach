import Link from "next/link";
import { ClaimList } from "../ClaimList";
import { PAYPAL_CLAIMS, PAYPAL_SCREENS } from "../claims";

export default function PayPalEvidence() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>How it uses PayPal</h1>
      </header>
      <p>Each line is real code, in the file named. A test fails if the code leaves that file. PayPal sandbox, no real charge. Everything that keeps families safe stays free.</p>
      <ClaimList claims={PAYPAL_CLAIMS} />
      <h2 className="section-title">Where you see each call</h2>
      <p>On a demo shop, the queue and each refund page also list what the app just asked PayPal, under What this app asked PayPal.</p>
      <div className="window table-window">
        <table className="ledger" data-testid="paypal-screens">
          <thead>
            <tr>
              <th>Call</th>
              <th>Where you see it</th>
            </tr>
          </thead>
          <tbody>
            {PAYPAL_SCREENS.map((s) => (
              <tr key={s.what}>
                <td className="id">{s.what}</td>
                <td>{s.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="section-title">What PayPal&apos;s data does not do</h2>
      <p>
        Nothing PayPal returns goes to Claude or Channel3. Claude reads CPSC&apos;s public text and the shop&apos;s own item titles. Sales join to those items here, by order number, SKU or exact title. Tests plant PayPal values in the database and check they are in no request Claude would receive from the recall check, the record check, the question writer, the follow-up adviser or Studio. The shopping agent reads only CPSC&apos;s records and public listings. One more test plants them and finds none in the market searches the recall sweep sends to Channel3. They stop at the wire: they read what would be sent, and make no network call.
      </p>
      <h2 className="section-title">What a person decides</h2>
      <p>A person approves every refund, and every notice unless they turn on preparing them for one recall. Either way they send each notice from their own mail. The agent has no refund tool, and the mail is opened in the shop&apos;s own account. See the <Link href="/safety">safety checks</Link>.</p>
      <div className="provenance">
        <span className="chip chip-sandbox">Sandbox PayPal</span>
      </div>
    </main>
  );
}
