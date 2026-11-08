import Link from "next/link";

export const metadata = { title: "Terms" };

export default function Terms() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>Terms</h1>
      </header>
      <p>Recall Reach is a hackathon project. It runs on PayPal&apos;s sandbox, so no real money moves.</p>
      <p>
        It compares a shop&apos;s own sales and listings with U.S. CPSC recalls. A match is for a person to check. It doesn&apos;t say an item is recalled, and no match doesn&apos;t mean an
        item is safe. Check recalls at <a href="https://www.cpsc.gov/Recalls">cpsc.gov/Recalls</a>.
      </p>
      <p>Nothing goes out without the shop&apos;s owner. Each notice and each refund waits for the owner&apos;s approval, and the app never emails anyone.</p>
      <p>Connecting a PayPal account and signing in with PayPal are optional. From your queue you can disconnect, unlink, or delete your shop&apos;s data at any time.</p>
      <p>It&apos;s offered as it is, with no warranty.</p>
      <p className="note">
        What it keeps: <Link href="/privacy">Privacy</Link>.
      </p>
    </main>
  );
}
