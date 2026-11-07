import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { isRecallNumber, readPublicRecall } from "@/server/match/textCheck";
import { CpscInSpanish } from "@/app/r/CpscInSpanish";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "A CPSC recall" };

/** CPSC's public record for one recall, to pass to whoever has the product now. Nothing else is read, and nothing here is about anyone. */
export default async function PublicRecallPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  if (!isRecallNumber(number)) notFound();
  const recall = await readPublicRecall(getDb(), number);
  if (!recall.found) notFound();
  return (
    <main className="family">
      <div className="column">
        <h1>{recall.title}</h1>
        {recall.image ? (
          <figure className="photo">
            {/* eslint-disable-next-line @next/next/no-img-element -- CPSC's own photo, served by CPSC */}
            <img src={recall.image.url} alt={recall.image.caption} referrerPolicy="no-referrer" />
            <figcaption>{recall.image.caption}. Photo from CPSC.</figcaption>
          </figure>
        ) : null}
        <h2>What was recalled, in CPSC&apos;s words</h2>
        <p>{recall.description}</p>
        <h2>The hazard, in CPSC&apos;s words</h2>
        <div className="hazard">
          {recall.hazards.map((h) => (
            <p key={h}>{h}</p>
          ))}
        </div>
        <h2>What to do, in CPSC&apos;s words</h2>
        {recall.remedies.map((r) => (
          <p key={r}>{r}</p>
        ))}
        <p>
          <a href={recall.url}>Open CPSC&apos;s recall page</a>
        </p>
        <footer>
          <CpscInSpanish />
          <p>From CPSC&apos;s public recall record.</p>
        </footer>
      </div>
    </main>
  );
}
