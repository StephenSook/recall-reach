import { headers } from "next/headers";
import Link from "next/link";
import { getDb } from "@/server/db/pg";
import { MAX_FILE_BYTES, MAX_LINES, OWN_FILE_DAYS } from "@/server/import/ownFile";
import { checkText, MAX_MODEL, MAX_TITLE, readTextCheck } from "@/server/match/textCheck";
import { businessDay } from "@/server/time/businessDay";
import { publicCheckAllowed } from "@/server/web/publicCheck";
import { CheckForm, ItemForm, StoreForm } from "./CheckForm";
import { type ItemAnswer, readItemAnswer } from "./itemAnswer";
import { ItemAnswerView } from "./ItemAnswerView";
import { NARTS_PAGE, nartsLine } from "./nartsList";
import { OWNER_CODES } from "@/server/owner/messages";

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
  ...OWNER_CODES,
};

const NOTHING_TYPED = "Type what's on the label, or a model number.";
/** Enough to open the whole list of a product kind. The public API's own list stays shorter. */
const MAX_SHOWN = 60;

const typed = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

/** The same rules and limit as /api/check, and no model runs. See the note on what happens to what's typed. */
async function checkItem(title: string, model: string): Promise<{ answer: ItemAnswer; checked: string } | { refused: string }> {
  const input = readTextCheck(title, model);
  if ("error" in input) return { refused: NOTHING_TYPED };
  if (!publicCheckAllowed(await headers())) return { refused: ERRORS.BUSY };
  try {
    const checked = `${input.title} ${input.model}`.trim();
    return { answer: readItemAnswer(await checkText(getDb(), input, businessDay(), { maxResults: MAX_SHOWN })), checked };
  } catch (err) {
    // The name only: a database error can quote the text it was given.
    console.error("one item check failed:", err instanceof Error ? err.name : "unknown error");
    return { refused: ERRORS.FAILED };
  }
}

export default async function CheckPage({ searchParams }: { searchParams: Promise<{ error?: string | string[]; title?: string | string[]; model?: string | string[] }> }) {
  const params = await searchParams;
  const { error } = params;
  const message = typeof error === "string" && Object.hasOwn(ERRORS, error) ? ERRORS[error] : null;
  const title = typed(params.title);
  const model = typed(params.model);
  const item = title !== undefined || model !== undefined ? await checkItem(title ?? "", model ?? "") : null;
  const narts = nartsLine(`${title ?? ""} ${model ?? ""}`);
  return (
    <main className="page">
      <header className="page-head">
        <h1>Check one item</h1>
      </header>
      {message ? (
        <p role="alert" className="alert">
          {message}
        </p>
      ) : null}
      <p>Before you take something in or put it out.</p>
      <ItemForm title={title ?? ""} model={model ?? ""} maxTitle={MAX_TITLE} maxModel={MAX_MODEL} />
      {item && "refused" in item ? (
        <p role="alert" className="alert">
          {item.refused}
        </p>
      ) : null}
      {item && "answer" in item ? <ItemAnswerView answer={item.answer} checked={item.checked} /> : null}
      <p className="note">
        This checks CPSC recalls. Car seats are recalled through NHTSA, so check <a href="https://www.nhtsa.gov/recalls">nhtsa.gov/recalls</a>.
        {narts ? (
          <>
            {" "}
            The resale trade group <a href={NARTS_PAGE}>NARTS</a> {narts}
          </>
        ) : null}
      </p>
      <h2 className="section-title">Check your own order file</h2>
      <p>See which past sales match a real CPSC recall. Nothing goes to a family without you.</p>
      <CheckForm />
      <p className="note">
        <a href="/sample-order-file.csv">Try a sample file</a>.
      </p>
      <form action="/api/owner/paypal/start" method="post" className="actions" data-testid="owner-signin-start">
        <input type="hidden" name="intent" value="signin" />
        <button type="submit" className="btn btn-outline">
          Sign in with PayPal
        </button>
      </form>
      <p className="note">Already have a shop here? Signing in with PayPal opens it, once you&apos;ve linked your PayPal login from your shop&apos;s queue.</p>
      <details className="check-details">
        <summary>What this keeps and checks</summary>
        <p className="note">Our code doesn&apos;t store or log what you type in Check one item. The form puts it in the page address, so the web host&apos;s request logs may include it.</p>
        <p className="note">It&apos;s built for Shopify&apos;s order export columns. Any other CSV needs order_number, title, quantity, unit_price, currency and ordered_on.</p>
        <p className="note">We check CPSC recalls from 2022 on. A shop is checked when a recall first appears. Later edits to that recall don&apos;t re-run it.</p>
        <p className="note">
          We keep only those columns, and buyer emails are encrypted. A refund needs your own PayPal account connected, from your queue. If you press Check with Claude, the item&apos;s title and SKU go to Anthropic, never a buyer&apos;s details. Everything is deleted after {OWN_FILE_DAYS} days, or sooner if you ask. Link your PayPal login from your queue to keep it longer: until you delete it, or a year passes with no PayPal sign-in or link.
        </p>
      </details>
      <h2 className="section-title">No file with you?</h2>
      <p>A Shopify store&apos;s public listings can be checked right now. This checks what&apos;s listed today. Only your order file checks past sales.</p>
      <StoreForm />
      <p className="note">
        We read your store&apos;s public product feed and keep each title and whether it&apos;s for sale, nothing else. Results show only in this browser, and are deleted after {OWN_FILE_DAYS} days, or sooner if you ask, unless you link your PayPal login from your queue. Listings can&apos;t be refunded, and no message can go out from them.
      </p>
      <p className="note">
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
