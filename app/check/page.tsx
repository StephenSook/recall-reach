import Link from "next/link";
import { MAX_FILE_BYTES, MAX_LINES, OWN_FILE_DAYS } from "@/server/import/ownFile";
import { CheckForm, StoreForm } from "./CheckForm";

// The route sends a visitor here with a code, and only these sentences are shown.
const ERRORS: Record<string, string> = {
  NO_NAME: "Add your shop's name. It goes in the messages families read.",
  NOT_READABLE: "That file isn't a Shopify order export or a CSV with the columns below.",
  EMPTY: "That file has no order lines we could read.",
  TOO_MANY: `That file has more than ${MAX_LINES} lines. Export a shorter date range.`,
  TOO_BIG: `That file is over ${MAX_FILE_BYTES / 1_000_000} MB. Export a shorter date range.`,
  BAD_ADDRESS: "That isn't a store address we can read. Type it like yourstore.com.",
  CANT_REACH: "We couldn't reach that address. Check the spelling, or upload your order file.",
  NO_FEED: "That store doesn't share a public Shopify product feed. Upload your order file instead.",
  ROBOTS: "That store asks tools like this not to read its feed, so we didn't. Upload your order file instead.",
  MOVED: "That address sends visitors to another one. Open your store in a browser and type the address it shows.",
  EMPTY_FEED: "That store's feed lists nothing to check.",
  BUSY: "Too many checks from here. Try again in an hour.",
  FAILED: "The check could not run. Please try again.",
};

export default async function CheckPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const message = typeof error === "string" && Object.hasOwn(ERRORS, error) ? ERRORS[error] : null;
  return (
    <main className="page">
      <header className="page-head">
        <h1>Check your own order file</h1>
      </header>
      <p>See which past sales match a real CPSC recall. Nothing goes to a family without you.</p>
      {message ? (
        <p role="alert" className="alert">
          {message}
        </p>
      ) : null}
      <CheckForm />
      <p className="note">
        A Shopify order export works as it is. Any other CSV needs order_number, title, quantity, unit_price, currency and ordered_on. <a href="/sample-order-file.csv">Try a sample file</a>.
      </p>
      <p className="note">
        This checks CPSC recalls. Car seats are recalled through NHTSA, so check <a href="https://www.nhtsa.gov/recalls">nhtsa.gov/recalls</a>.
      </p>
      <p className="note">
        We check CPSC recalls from 2022 on. A shop is checked when a recall first appears. Later edits to that recall don&apos;t re-run it.
      </p>
      <p className="note">
        We keep only those columns, and buyer emails are encrypted. No PayPal account is connected, so this can&apos;t refund anything. If you press Check with Claude, the item&apos;s title and SKU go to Anthropic, never a buyer&apos;s details. Everything is deleted after {OWN_FILE_DAYS} days, or sooner if you ask.
      </p>
      <h2 className="section-title">No file with you?</h2>
      <p>A Shopify store&apos;s public listings can be checked right now. This checks what&apos;s listed today. Only your order file checks past sales.</p>
      <StoreForm />
      <p className="note">
        We read your store&apos;s public product feed and keep each title and whether it&apos;s for sale, nothing else. Results show only in this browser, and are deleted after {OWN_FILE_DAYS} days, or sooner if you ask. Listings can&apos;t be refunded, and no message can go out from them.
      </p>
      <p className="note">
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
