import { ShopperForm } from "./ShopperForm";

export const metadata = { title: "Shopping agent" };

// The route sends a visitor here with a code, and only these sentences are shown.
const ERRORS: Record<string, string> = {
  NO_SLIP: "That offer isn't here any more. Search again.",
  EXPIRED: "That offer has run out or was already used. Search again.",
  CHANGED: "That listing's price or title changed, so nothing was started. Search again.",
  GONE: "That listing couldn't be read again, so nothing was started. Search again.",
  NOW_FLAGGED: "That listing no longer comes back with no recall match, so nothing was started.",
  NOT_PAID: "PayPal doesn't show this order as complete.",
  BUSY: "Too many tries from here. Try again in an hour.",
  FAILED: "That didn't go through. Please try again.",
};

export default async function ShopperPage({ searchParams }: { searchParams: Promise<{ error?: string | string[]; cancelled?: string | string[] }> }) {
  const { error, cancelled } = await searchParams;
  const message = typeof error === "string" && Object.hasOwn(ERRORS, error) ? ERRORS[error] : cancelled ? "You cancelled at PayPal. Nothing was bought." : null;
  return (
    <main className="page">
      <header className="page-head">
        <h1>Ask an agent to find it, with the recall check first</h1>
      </header>
      <p>An agent searches public store listings and checks one against CPSC recalls before it may offer it. If a listing names a recall, it can&apos;t offer that one and looks for another.</p>
      {message ? (
        <p role="alert" className="alert">
          {message}
        </p>
      ) : null}
      <ShopperForm />
      <p className="note">The agent never sees a price and can&apos;t set one. It can&apos;t buy anything. You decide on PayPal&apos;s page.</p>
      <p className="note">This uses PayPal&apos;s sandbox. It&apos;s test money, nothing ships, and no store is paid. PayPal&apos;s page needs a sandbox buyer login.</p>
    </main>
  );
}
