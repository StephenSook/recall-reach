import Link from "next/link";
import { MAX_FILE_BYTES, MAX_LINES, OWN_FILE_DAYS } from "@/server/import/ownFile";

// The route sends a visitor here with a code, and only these sentences are shown.
const ERRORS: Record<string, string> = {
  NO_NAME: "Add your shop's name. It goes in the messages families read.",
  NOT_READABLE: "That file isn't a Shopify order export or a CSV with the columns below.",
  EMPTY: "That file has no order lines we could read.",
  TOO_MANY: `That file has more than ${MAX_LINES} lines. Export a shorter date range.`,
  TOO_BIG: `That file is over ${MAX_FILE_BYTES / 1_000_000} MB. Export a shorter date range.`,
  BUSY: "Too many files from here. Try again in an hour.",
  FAILED: "The file could not be checked. Please try again.",
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
      <form className="window upload" action="/api/shop/import" method="post" encType="multipart/form-data">
        <label className="field">
          Your shop&apos;s name
          <input name="shopName" maxLength={80} autoComplete="organization" required />
        </label>
        <label className="field">
          Your order file
          <input type="file" name="file" accept=".csv,text/csv" required />
        </label>
        <button type="submit" className="btn big">
          Check my file
        </button>
      </form>
      <p className="note">
        A Shopify order export works as it is. Any other CSV needs order_number, title, quantity, unit_price, currency and ordered_on. <a href="/sample-order-file.csv">Try a sample file</a>.
      </p>
      <p className="note">
        We check CPSC recalls from 2022 on. A shop is checked when a recall first appears. Later edits to that recall don&apos;t re-run it.
      </p>
      <p className="note">
        We keep only those columns, and buyer emails are encrypted. No PayPal account is connected, so this can&apos;t refund anything. If you press Check with Claude, the item&apos;s title and SKU go to Anthropic, never a buyer&apos;s details. Everything is deleted after {OWN_FILE_DAYS} days, or sooner if you ask.
      </p>
      <p className="note">
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
