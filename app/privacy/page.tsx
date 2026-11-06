const NOTE = `If a product you bought from us is recalled for safety, we may email you about it using the email from your order. We check our past sales against U.S. CPSC recalls. Product details from our own catalog may be processed by our service provider, Anthropic. We never use this for marketing. Sales data from PayPal is deleted within 48 hours.`;
const OPT_IN = `Email me if an item I buy is recalled for safety.`;

export default function Privacy() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>Privacy</h1>
      </header>
      <h2 className="section-title">What this app keeps</h2>
      <p>Your order file&apos;s columns, with buyer emails encrypted, deleted after 7 days or when you ask. CPSC&apos;s public recalls. PayPal sales data is built to be deleted within 48 hours under PayPal&apos;s deletion rule. Stored decisions use your own order number or a keyed hash. It keeps a keyed fingerprint of each PayPal webhook delivery to refuse repeats, with no ids or amounts.</p>
      <h2 className="section-title">What goes to a third party</h2>
      <p>If you press Check with Claude, CPSC&apos;s text and your item&apos;s title, SKU and listing description go to Anthropic. Nothing PayPal returns does, and no buyer&apos;s details do. The app never emails anyone: messages open in your own mail, and you send them.</p>
      <h2 className="section-title">For your shop&apos;s privacy policy</h2>
      <p>You can copy this. It is a template, not legal advice.</p>
      <pre data-testid="privacy-note">{NOTE}</pre>
      <h2 className="section-title">For your checkout</h2>
      <p>A box buyers can tick, so future buyers have said yes. For past buyers who never saw it, whether PayPal&apos;s terms allow this email is unclear, and we say so plainly.</p>
      <pre data-testid="opt-in">{OPT_IN}</pre>
    </main>
  );
}
