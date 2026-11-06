import Link from "next/link";
import { ClaimList } from "../ClaimList";
import { PAYPAL_CLAIMS } from "../claims";

export default function PayPalEvidence() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>How it uses PayPal</h1>
      </header>
      <p>Each line is real code, in the file named. A test fails if the code leaves that file.</p>
      <ClaimList claims={PAYPAL_CLAIMS} />
      <h2 className="section-title">What PayPal&apos;s data does not do</h2>
      <p>
        Nothing PayPal returns goes to Claude or any other third party. Claude reads CPSC&apos;s public text and the shop&apos;s own item titles. Sales join to those items here, by order number, SKU or exact title. A test plants PayPal values in the database and checks they are in no request Claude would receive, on every path that reaches Claude. That test stops at the wire: it reads the requests the SDK would send, and makes no network call.
      </p>
      <h2 className="section-title">What a person decides</h2>
      <p>A person approves every notice and every refund. The agent has no refund tool, and the mail is opened in the shop&apos;s own account. See the <Link href="/safety">safety checks</Link>.</p>
      <div className="provenance">
        <span className="chip chip-sandbox">Sandbox PayPal</span>
      </div>
    </main>
  );
}
