import Link from "next/link";
import { redirect } from "next/navigation";
import { Fragment } from "react";
import { getDb } from "@/server/db/pg";
import { agentConfigured } from "@/server/agent/questionStore";
import { centsToValue } from "@/server/paypal/orders";
import { loadQueue, tellCpscDraft, toCards, type QueueCard } from "@/server/queue/queue";
import { currentSession, secret } from "@/server/web/http";
import { trustedMessage } from "@/server/web/queueMessage";
import { gridRows, unidentifiedRows } from "./gridRows";
import { BuyButtons } from "./BuyButtons";
import { agentHeadline, canNotify, CHECK_RESULT, chipClass, chipsFor, counted, coverageLine, listingCounts, listingCoverageLine, needsApproval, paymentLine, NOTICE_STATE, queueCounts, REFUND_STATE, saleWaits, sitsApart, splitCounts, traceLine, refundOnOffer } from "./labels";
import { LookAgain } from "./LookAgain";
import { MatchGridLoader } from "./MatchGridLoader";
import { NoticeActions } from "./NoticeActions";
import { PushRegister } from "./PushRegister";
import { SellerAnswerForm } from "./SellerAnswerForm";
import { RefundForm } from "./RefundForm";
import { WatchForSale } from "./WatchForSale";

export const dynamic = "force-dynamic";

/** One sale that needs a person. Cleared recalls are a plain list on the page: there is nothing to do on them. */
function Card({ card, shopName, shopKind, agentReady, saleOnItsWay, answered }: { card: QueueCard; shopName: string; shopKind: string; agentReady: boolean; saleOnItsWay: boolean; answered: unknown }) {
  const row = card.lead;
  const productWordsOnly = row.strength === "PRODUCT_WORDS";
  const notifiable = canNotify(row);
  const canApprove = notifiable && needsApproval(row);
  const canAskClaude = agentReady && !row.agent && row.verdict !== "CLEARED";
  const canBuy = shopKind === "DEMO" && row.isListing && row.stillListed && row.verdict !== "CLEARED";
  // A form's fragment survives the redirect, so on a wide screen this window stays open after an action.
  const here = `#sale-${row.matchId}`;
  return (
    <article className="window" id={`sale-${row.matchId}`} data-recall={row.recallNumber} data-verdict={row.verdict}>
      <header className="window-bar">
        <span className="id">CPSC recall {row.recallNumber}</span>
        <span className="chips">
          {chipsFor(row).map((chip) => (
            <span key={chip} className={chipClass(chip)}>
              {chip}
            </span>
          ))}
        </span>
      </header>
      <div className="window-body">
        <h3>{row.product}</h3>
        <p className="sale">
          {row.isListing ? "Listed" : "Sold"}: <strong>{row.itemTitle}</strong>
          {row.orderedOn ? <>, {row.orderedOn}</> : null}. Recalled {row.recallDate}. {paymentLine(row)}
        </p>
        <p className="quiet">{row.reason}</p>
        {row.caughtSeconds !== null ? <p data-testid="caught">Reached your queue {row.caughtSeconds} seconds after PayPal took the payment.</p> : null}
        {row.salePath === "REVIEW" && row.verdict === "MATCH" ? <p>Sold on the recall date. Please review.</p> : null}
        {row.verdict === "MATCH" && row.salePath === "REFUND_ELIGIBLE" && row.joinState === "HISTORY_UNAVAILABLE" ? <p>A refund needs your PayPal connected. This check read your file only.</p> : null}
        {row.verdict !== "CLEARED" && productWordsOnly ? <p>Nothing goes out on product words alone. Check the recall page.</p> : null}

        {notifiable && row.question ? (
          <div className="ask">
            The family is asked:
            <strong data-testid="family-question">{row.question.question}</strong>
            {row.question.kind === "written" ? (
              <details data-testid="question-source">
                <summary>Where this question came from</summary>
                <p>Claude wrote it from CPSC&apos;s words: &quot;{row.question.evidence}&quot;</p>
              </details>
            ) : null}
          </div>
        ) : null}

        {canApprove || canAskClaude || canBuy ? (
          <div className="actions">
            {canBuy ? <BuyButtons shopItemId={row.recordId} waiting={saleOnItsWay} /> : null}
            {canApprove ? (
              <form action={`/api/queue/notices${here}`} method="post">
                <input type="hidden" name="matchId" value={row.matchId} />
                <button type="submit" className="btn">
                  {row.verdict === "MATCH" ? "Approve this notice" : "Approve this check request"}
                </button>
              </form>
            ) : null}
            {canAskClaude ? (
              <form action={`/api/queue/agent${here}`} method="post">
                <input type="hidden" name="recordId" value={row.recordId} />
                <button type="submit" className="btn btn-outline">
                  Check with Claude
                </button>
              </form>
            ) : null}
          </div>
        ) : null}

        {row.notice ? (
          <section className="state-line" data-notice={row.notice.id}>
            <p>
              Notice: <strong data-testid="notice-state">{NOTICE_STATE[row.notice.state]}</strong>
            </p>
            {row.notice.stopped ? <p data-testid="family-report">Family says they stopped using it</p> : null}
            {row.notice.result ? <p data-testid="check-result">{CHECK_RESULT[row.notice.result]}</p> : null}
            {row.earlierQuestionResult ? <p data-testid="earlier-result">Earlier question: {CHECK_RESULT[row.earlierQuestionResult]}</p> : null}
            {notifiable && !needsApproval(row) ? <NoticeActions noticeId={row.notice.id} /> : null}
            {row.notice.state === "OPENED_IN_MAIL" ? (
              <form className="actions" action={`/api/queue/notices/${row.notice.id}/sent${here}`} method="post">
                <button type="submit" className="btn btn-outline">
                  I sent it
                </button>
              </form>
            ) : null}
          </section>
        ) : null}

        {/* A refund already asked for stays on the card, even if the evidence has changed since: it may still need checking. */}
        {row.refund || (row.verdict === "MATCH" && row.salePath === "REFUND_ELIGIBLE" && row.joinState === "IDENTIFIED") ? (
          <section className="state-line">
            {refundOnOffer(row) && !row.approval ? (
              <form action={`/api/queue/refunds/approve${here}`} method="post">
                <input type="hidden" name="matchId" value={row.matchId} />
                <button type="submit" className="btn btn-outline">
                  Review refund
                </button>
              </form>
            ) : null}
            {refundOnOffer(row) && row.approval ? (
              <RefundForm approvalId={row.approval.id} label={`Refund ${centsToValue(row.approval.amountCents)} ${row.approval.currency}`} />
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
              <p>CPSC asks resellers to tell them if they may have sold a recalled product. Copy this and send it through SaferProducts.gov. We don&apos;t send it for you.</p>
              <pre data-testid="tell-cpsc">
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

        {row.agent ? (
          <details data-testid="how-it-checked">
            <summary>{agentHeadline(row.agent)}</summary>
            {row.agent.reason ? <p>{row.agent.reason}</p> : null}
            {row.agent.missingField ? <p>Missing: {row.agent.missingField}</p> : null}
            {row.agent.evidence.length > 0 ? (
              <ul>
                {row.agent.evidence.map((e) => (
                  <li key={`${e.source}:${e.quote}`}>
                    {e.source === "recall" ? "CPSC" : "Your shop"}: &quot;{e.quote}&quot;
                  </li>
                ))}
              </ul>
            ) : null}
            <p>How it checked:</p>
            <ol>
              {row.agent.trace.map((step, i) => (
                <li key={i}>{traceLine(step)}</li>
              ))}
            </ol>
            <p>
              <small>{row.agent.model}. This is Claude reading the text. It changes nothing above and says nothing about safety.</small>
            </p>
          </details>
        ) : null}

        {row.verdict !== "CLEARED" ? (
          <details open={answered === row.matchId}>
            <summary>Why this came up</summary>
            {row.matched.length > 0 ? <p>Shared: {row.matched.join("; ")}</p> : null}
            {row.missing.length > 0 ? <p>Missing: {row.missing.join("; ")}</p> : null}
            <p>
              <a href={row.recallUrl}>CPSC&apos;s recall page</a>. <Link href={`/sweep/${row.recallNumber}`}>On the market now</Link>.{" "}
              {/* A plain link: a full page load keeps the timeline's stylesheet off the page that holds the grid. */}
              {row.orderedOn ? (
                <>
                  <a href={`/queue/recalls/${row.recallNumber}`}>Refund windows</a>.
                </>
              ) : null}
            </p>
            <SellerAnswerForm matchId={row.matchId} answer={row.sellerAnswer} demo={shopKind === "DEMO"} />
          </details>
        ) : null}

        {card.also.length > 0 ? (
          <details data-testid="also">
            <summary>
              {card.also.length} other possible {card.also.length === 1 ? "recall" : "recalls"} for this {row.isListing ? "listing" : "sale"}
            </summary>
            <ul>
              {card.also.map((other) => (
                <li key={other.matchId}>
                  <a href={other.recallUrl}>
                    CPSC recall {other.recallNumber}: {other.product}
                  </a>{" "}
                  ({chipsFor(other).join(", ")}). {other.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="provenance">
          <span className="chip chip-real">Real CPSC</span>
          {shopKind === "DEMO" ? <span className="chip chip-sandbox">Sandbox PayPal</span> : null}
          <span className="chip chip-sandbox">{shopKind === "DEMO" ? "Demo shop" : "Real shop"}</span>
          <small>{row.source}</small>
        </div>
      </div>
    </article>
  );
}

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ message?: string | string[]; sig?: string | string[]; answered?: string | string[] }> }) {
  const session = await currentSession();
  if (!session) redirect("/");
  const { rows, shop, listings, coverage, pendingLiveSales, unidentified } = await loadQueue(getDb(), session.shopId, session.sessionId);
  // A session can outlast its shop, which is deleted with its data. There is no queue left to show.
  if (!shop) redirect("/");
  const params = await searchParams;
  const message = trustedMessage(secret("SESSION_SECRET"), params.message, params.sig);
  const shopName = shop.name;
  const shopKind = shop.kind;
  const { cards: found, cleared, unrelated } = toCards(rows);
  // A real shop's cards split by what they rest on, with shared words last. A demo shop keeps its one list, so its numbers can't move.
  const real = shopKind === "REAL";
  const cards = real ? [...found.filter((c) => !sitsApart(c)), ...found.filter(sitsApart)] : found;
  const agentReady = agentConfigured();
  const counts = queueCounts({ cards, cleared, unrelated, recallsChecked: coverage?.recallsChecked ?? null });
  const listed = listings ? listingCounts(cards, listings.total) : null;
  const split = real ? splitCounts(cards) : null;
  const waiting = real ? cards.filter((c) => saleWaits(c) && !sitsApart(c)).length : counts.waiting;
  const grid = gridRows(rows, cards, { sharedWordsApart: real, listings: Boolean(listed) });

  return (
    <main className="page">
      <PushRegister />
      <header className="page-head">
        <h1>{shopName}</h1>
        <span className="quiet">{listed ? `${listed.needCheck} ${counted(listed.needCheck, "needs a check", "need a check")}` : `${waiting} ${counted(waiting, "item waits", "items wait")} for you`}</span>
      </header>
      {listed ? (
        <>
          <p data-testid="listings-lead">This compares listing titles with CPSC recalls. It doesn&apos;t say this store sold a recalled product. None is confirmed: only the item in hand can settle it.</p>
          <p className="note">
            This checks what&apos;s listed today. <Link href="/check">Your order file</Link> is what checks past sales.
          </p>
        </>
      ) : (
        <p>Check each match, then approve what goes out. Nothing is sent without you.</p>
      )}
      {message ? (
        <p role="alert" className="alert">
          {message}
        </p>
      ) : null}
      {pendingLiveSales > 0 ? <WatchForSale /> : rows.some((r) => r.notice && r.notice.state !== "FAMILY_RESPONDED") ? <LookAgain everyMs={3_000} forMs={180_000} /> : null}
      {listed ? (
        <div className="stats" data-testid="stats">
          <div className="stat">
            <span className="stat-value">{listed.total.toLocaleString("en-US")}</span>
            <span className="stat-label">{counted(listed.total, "Listing read", "Listings read")}</span>
          </div>
          <div className="stat stat-SCOPE_GAP">
            <span className="stat-value">{listed.needCheck}</span>
            <span className="stat-label">{counted(listed.needCheck, "Needs a check", "Need a check")}</span>
          </div>
          <div className="stat">
            <span className="stat-value">{listed.sharedWord}</span>
            <span className="stat-label">Share a word only</span>
          </div>
          <div className="stat">
            <span className="stat-value">{listed.notFlagged.toLocaleString("en-US")}</span>
            <span className="stat-label">Not flagged</span>
          </div>
        </div>
      ) : (
        <div className="stats" data-testid="stats">
          <div className="stat">
            <span className="stat-value">{counts.recallsChecked?.toLocaleString("en-US") ?? "None"}</span>
            <span className="stat-label">{counted(counts.recallsChecked ?? 0, "Recall checked", "Recalls checked")}</span>
          </div>
          {split ? (
            <>
              <div className="stat stat-SCOPE_GAP">
                <span className="stat-value">{split.needCheck}</span>
                <span className="stat-label">{counted(split.needCheck, "Needs a check", "Need a check")}</span>
              </div>
              <div className="stat">
                <span className="stat-value">{split.sharedWord}</span>
                <span className="stat-label">Share a word only</span>
              </div>
            </>
          ) : (
            <>
              <div className="stat stat-MATCH">
                <span className="stat-value">{counts.matched}</span>
                <span className="stat-label">Matched</span>
              </div>
              <div className="stat stat-SCOPE_GAP">
                <span className="stat-value">{counts.scopeGaps}</span>
                <span className="stat-label">Can&apos;t tell yet</span>
              </div>
            </>
          )}
          <div className="stat stat-CLEARED">
            <span className="stat-value">{counts.cleared}</span>
            <span className="stat-label">Cleared</span>
          </div>
        </div>
      )}
      <p className="note">
        {coverage ? <span data-testid="coverage">{listings ? listingCoverageLine(coverage, listings) : coverageLine(coverage)} </span> : null}
        {shopKind === "DEMO" ? "Dates marked seeded are demo data. " : null}
        {agentReady ? null : <span data-testid="agent-unavailable">Claude check unavailable.</span>}
      </p>
      <noscript>
        <style>{`.cards > .window, .narrow-only { display: block !important; } .cards-hint { display: none !important; } .queue-heading { position: static !important; width: auto !important; height: auto !important; overflow: visible !important; clip-path: none !important; white-space: normal !important; }`}</style>
      </noscript>
      {/* Above the grid, because the grid draws late: anything below it gets pushed off screen after the browser has scrolled to it. */}
      <section data-testid="needs" className="cards">
        <h2 className="section-title queue-heading">Your queue</h2>
        {/* One list in a fixed order, with each card's chip saying where it stands. A card moved to another list or place loses the browser's :target, and an open card would close by itself. */}
        {cards.map((card, i) => (
          <Fragment key={card.lead.matchId}>
            {real && sitsApart(card) && (i === 0 || !sitsApart(cards[i - 1])) ? <h2 className="section-title narrow-only">Share a word only</h2> : null}
            <Card card={card} shopName={shopName} shopKind={shopKind} agentReady={agentReady} saleOnItsWay={pendingLiveSales > 0} answered={params.answered} />
          </Fragment>
        ))}
      </section>
      <MatchGridLoader rows={[...grid, ...unidentifiedRows(unidentified)]} startOn={listed && grid.some((r) => r.isLead && r.listedOnShelf) ? "shelf" : "needs"} listings={Boolean(listed)} />
      <p className="cards-hint note">Open a row to work on it.</p>
      {cleared.length > 0 || unrelated > 0 ? (
        <section className="narrow-only">
          <h2 className="section-title">Checked and cleared</h2>
          {cleared.length > 0 ? (
            <div className="window" data-verdict="CLEARED" data-testid="cleared">
              <header className="window-bar">
                <span className="id">
                  {cleared.length} {cleared.length === 1 ? "recall" : "recalls"}
                </span>
                <span className="chip">Cleared</span>
              </header>
              <ul className="cleared-list">
                {cleared.map((row) => (
                  <li key={row.matchId} data-recall={row.recallNumber}>
                    <span className="id">CPSC recall {row.recallNumber}</span> <strong>{row.product}</strong>
                    <span className="quiet">
                      {row.itemTitle}: {row.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {unrelated > 0 ? (
            <p data-testid="unrelated" className="note">
              {unrelated} more {unrelated === 1 ? "recall" : "recalls"} came up in the search and {unrelated === 1 ? "shares" : "share"} no brand or product word.
            </p>
          ) : null}
        </section>
      ) : null}
      {unidentified.length > 0 ? (
        <section className="narrow-only" data-testid="unidentified">
          <h2 className="section-title">Couldn&apos;t identify</h2>
          <ul className="window cleared-list">
            {unidentifiedRows(unidentified).map((p) => (
              <li key={p.matchId}>
                <strong>{p.itemTitle}</strong>
                {p.soldOn ? <>, {p.soldOn}</> : null}
                <span className="quiet">{p.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {shopKind === "REAL" ? (
        <details className="delete-data">
          <summary>Delete my data</summary>
          <p>{listed ? "This deletes your listings and their checks, for good." : "This deletes your file, its checks and any messages you prepared, for good."}</p>
          <form action="/api/shop/delete" method="post">
            <button type="submit" className="btn btn-outline">
              Delete everything
            </button>
          </form>
        </details>
      ) : null}
    </main>
  );
}
