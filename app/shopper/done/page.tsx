import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { readFinishedSlip } from "@/server/paypal/shopperOrder";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sandbox order complete" };

export default async function ShopperDonePage({ searchParams }: { searchParams: Promise<{ slip?: string | string[] }> }) {
  const { slip } = await searchParams;
  const done = typeof slip === "string" ? await readFinishedSlip(getDb(), slip) : null;
  if (!done) notFound();
  return (
    <main className="page">
      <header className="page-head">
        <h1>PayPal says this sandbox order is complete</h1>
      </header>
      <p data-testid="shopper-done">
        {done.title}, {(done.priceCents / 100).toFixed(2)} {done.currency}.
      </p>
      <p>It was test money. Nothing ships, and no store was paid.</p>
      <p>
        <Link href="/shopper">Search again</Link>
      </p>
    </main>
  );
}
