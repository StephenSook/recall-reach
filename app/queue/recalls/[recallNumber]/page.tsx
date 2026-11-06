import { notFound, redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { loadQueue } from "@/server/queue/queue";
import { businessDay } from "@/server/time/businessDay";
import { currentSession } from "@/server/web/http";
import { RefundTimelineLoader } from "../RefundTimelineLoader";
import { timelineFor } from "../timeline";

export const dynamic = "force-dynamic";

export default async function RecallTimelinePage({ params }: { params: Promise<{ recallNumber: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/");
  const { recallNumber } = await params;
  const { rows, shop } = await loadQueue(getDb(), session.shopId, session.sessionId);
  if (!shop) redirect("/");
  const timeline = timelineFor(rows, recallNumber, businessDay());
  if (!timeline) notFound();
  return (
    <main className="page">
      <header className="page-head">
        <h1>Refund windows</h1>
        <span className="quiet id">CPSC recall {recallNumber}</span>
      </header>
      <p>{timeline.recallTitle}</p>
      <RefundTimelineLoader timeline={timeline} />
      <ul className="window cleared-list" data-testid="timeline-list">
        {timeline.sales.map((s) => (
          <li key={s.id}>
            <strong>{s.title}</strong>
            <span className="quiet">
              Sold {s.orderedOn}. {s.meaning}. 180 days end {s.windowEnds}.
            </span>
          </li>
        ))}
      </ul>
      <p className="note">
        A refund is only offered for a sale made after the recall, within 180 days. Recall date {timeline.recallDate}. <a href="/queue">Back to the queue</a>
      </p>
      {shop.kind === "DEMO" ? (
        <div className="provenance">
          <span className="chip chip-real">Real CPSC</span>
          <span className="chip chip-sandbox">Demo shop</span>
        </div>
      ) : null}
    </main>
  );
}
