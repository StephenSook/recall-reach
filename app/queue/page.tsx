import { redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { centsToValue } from "@/server/paypal/orders";
import { loadQueue, tellCpscDraft, toCards, type QueueCard } from "@/server/queue/queue";
import { currentSession } from "@/server/web/http";
import { CHECK_RESULT, chipsFor, NOTICE_STATE, REFUND_STATE } from "./labels";
import { NoticeActions } from "./NoticeActions";

export const dynamic = "force-dynamic";

function Card({ card, shopName, shopKind }: { card: QueueCard; shopName: string; shopKind: string }) {
  const row = card.lead;
  const blocked = row.joinState === "AMBIGUOUS_JOIN";
  const productWordsOnly = row.strength === "PRODUCT_WORDS";
  const canNotify = row.verdict !== "CLEARED" && !row.isListing && !blocked && !productWordsOnly;
  // The evidence changed before this went out, so it needs approving again as the right message.
  const staleNotice = row.notice !== null && (row.notice.state === "PREPARED" || row.notice.state === "OPENED_IN_MAIL") && (row.notice.kind === "SAFETY_NOTICE") !== (row.verdict === "MATCH");
  const provenance = shopKind === "DEMO" ? "REAL CPSC, SANDBOX PAYPAL, DEMO SHOP" : "REAL CPSC, SANDBOX PAYPAL, REAL SHOP";
  return (
    <article data-recall={row.recallNumber} data-verdict={row.verdict}>
      <h3>
        CPSC recall {row.recallNumber}: {row.product}
      </h3>
      <p>
        <strong>{chipsFor(row).join(" | ")}</strong>
      </p>
      <p>
        Item: {row.itemTitle}
        {row.orderedOn ? <> | Sold {row.orderedOn}</> : null} | Recall date {row.recallDate}
      </p>
      <p>
        <small>
          {provenance}. {row.source}
        </small>
      </p>
      <p>{row.reason}</p>
      {row.matched.length > 0 ? <p>Shared: {row.matched.join("; ")}</p> : null}
      {row.missing.length > 0 ? <p>Missing: {row.missing.join("; ")}</p> : null}
      {row.salePath === "REVIEW" && row.verdict === "MATCH" ? <p>Sold on the recall date. Please review.</p> : null}
      {row.verdict !== "CLEARED" && productWordsOnly ? <p>Nothing goes out on product words alone. Check the recall page.</p> : null}
      {row.verdict !== "CLEARED" ? (
        <p>
          <a href={row.recallUrl}>CPSC&apos;s recall page</a>
        </p>
      ) : null}

      {canNotify && (!row.notice || staleNotice) ? (
        <form action="/api/queue/notices" method="post">
          <input type="hidden" name="matchId" value={row.matchId} />
          <button type="submit">{row.verdict === "MATCH" ? "Approve this notice" : "Approve this check request"}</button>
        </form>
      ) : null}

      {row.notice ? (
        <section data-notice={row.notice.id}>
          <p>
            Notice: <strong data-testid="notice-state">{NOTICE_STATE[row.notice.state]}</strong>
          </p>
          {row.notice.stopped ? <p data-testid="family-report">Family says they stopped using it</p> : null}
          {row.notice.result ? <p data-testid="check-result">{CHECK_RESULT[row.notice.result]}</p> : null}
          {canNotify && !staleNotice ? <NoticeActions noticeId={row.notice.id} /> : null}
          {row.notice.state === "OPENED_IN_MAIL" ? (
            <form action={`/api/queue/notices/${row.notice.id}/sent`} method="post">
              <button type="submit">I sent it</button>
            </form>
          ) : null}
        </section>
      ) : null}

      {row.verdict === "MATCH" && row.salePath === "REFUND_ELIGIBLE" && row.joinState === "IDENTIFIED" ? (
        <section>
          {!row.refund && !row.approval ? (
            <form action="/api/queue/refunds/approve" method="post">
              <input type="hidden" name="matchId" value={row.matchId} />
              <button type="submit">Review refund</button>
            </form>
          ) : null}
          {row.approval && !row.refund ? (
            <form action="/api/queue/refunds/execute" method="post">
              <input type="hidden" name="approvalId" value={row.approval.id} />
              <button type="submit">
                Refund {centsToValue(row.approval.amountCents)} {row.approval.currency}
              </button>
            </form>
          ) : null}
          {row.refund ? (
            <p>
              <strong data-testid="refund-state">{REFUND_STATE[row.refund.status]}</strong>: {centsToValue(row.refund.amountCents)} {row.refund.currency}{" "}
              <a href={`/queue/refunds/${row.refund.id}`}>Check it against PayPal</a>
              {row.refund.failure ? <> ({row.refund.failure})</> : null}
            </p>
          ) : null}
          <details>
            <summary>Tell CPSC</summary>
            <p>
              CPSC asks resellers to tell them if they may have sold a recalled product. Copy this and send it through SaferProducts.gov. We don&apos;t send it for you.
            </p>
            <pre style={{ whiteSpace: "pre-wrap" }} data-testid="tell-cpsc">
              {tellCpscDraft({
                shopName,
                recallNumber: row.recallNumber,
                product: row.product,
                recallUrl: row.recallUrl,
                saleDates: row.orderedOn ? [row.orderedOn] : [],
              })}
            </pre>
            <p>
              <small>Source: cpsc.gov/FAQ/ResaleThrift-Stores</small>
            </p>
          </details>
        </section>
      ) : null}
      {card.also.length > 0 ? (
        <details data-testid="also">
          <summary>
            {card.also.length} other possible {card.also.length === 1 ? "recall" : "recalls"} for this sale
          </summary>
          <ul>
            {card.also.map((other) => (
              <li key={other.matchId}>
                <a href={other.recallUrl}>
                  CPSC recall {other.recallNumber}: {other.product}
                </a>{" "}
                ({chipsFor(other).join(" | ")}). {other.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/");
  const { rows, shop, coverage } = await loadQueue(getDb(), session.shopId, session.sessionId);
  const { message } = await searchParams;
  const shopName = shop?.name ?? "";
  const shopKind = shop?.kind ?? "DEMO";
  const { cards, cleared, unrelated } = toCards(rows);

  return (
    <main>
      <h1>{shopName}</h1>
      <p>Check each match, then approve what goes out. Nothing is sent without you.</p>
      {shopKind === "DEMO" ? (
        <p>
          <small>Demo shop. Order dates marked seeded are demo data; every sandbox capture is dated today.</small>
        </p>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
      {coverage ? (
        <p data-testid="coverage">
          Searched {coverage.searchedFrom ?? coverage.searchedTo} to {coverage.searchedTo}. {coverage.unidentifiedPayments} payments couldn&apos;t be identified.
          {" "}Checked {coverage.recallsChecked} recalls.
          {coverage.candidatesNotChecked > 0 ? ` ${coverage.candidatesNotChecked} candidates were not checked.` : ""}
        </p>
      ) : null}
      <section data-testid="needs">
        <h2>Needs review</h2>
        {cards.map((card) => (
          <Card key={card.lead.matchId} card={card} shopName={shopName} shopKind={shopKind} />
        ))}
      </section>
      {cleared.length > 0 || unrelated > 0 ? (
        <section>
          <h2>Checked and cleared</h2>
          {cleared.map((row) => (
            <Card key={row.matchId} card={{ lead: row, also: [] }} shopName={shopName} shopKind={shopKind} />
          ))}
          {unrelated > 0 ? (
            <p data-testid="unrelated">
              {unrelated} more {unrelated === 1 ? "recall" : "recalls"} came up in the search and {unrelated === 1 ? "shares" : "share"} no brand or product word.
            </p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
