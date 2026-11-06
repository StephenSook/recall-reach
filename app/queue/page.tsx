import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { agentConfigured } from "@/server/agent/questionStore";
import { centsToValue } from "@/server/paypal/orders";
import { loadQueue, tellCpscDraft, toCards, type QueueCard } from "@/server/queue/queue";
import { currentSession, secret } from "@/server/web/http";
import { trustedMessage } from "@/server/web/queueMessage";
import { gridRows, unidentifiedRows } from "./gridRows";
import { agentHeadline, canNotify, CHECK_RESULT, chipClass, chipsFor, counted, coverageLine, needsApproval, paymentLine, NOTICE_STATE, queueCounts, REFUND_STATE, traceLine } from "./labels";
import { MatchGridLoader } from "./MatchGridLoader";
import { NoticeActions } from "./NoticeActions";
import { WatchForSale } from "./WatchForSale";

export const dynamic = "force-dynamic";

/** One sale that needs a person. Cleared recalls are a plain list on the page: there is nothing to do on them. */
function Card({ card, shopName, shopKind, agentReady }: { card: QueueCard; shopName: string; shopKind: string; agentReady: boolean }) {
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
            {canBuy ? (
              <form action="/api/demo/buy" method="post">
                <input type="hidden" name="shopItemId" value={row.recordId} />
                <button type="submit" className="btn btn-outline">
                  Buy this as a family
                </button>
              </form>
            ) : null}
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

        {row.verdict === "MATCH" && row.salePath === "REFUND_ELIGIBLE" && row.joinState === "IDENTIFIED" ? (
          <section className="state-line">
            {!row.refund && !row.approval ? (
              <form action={`/api/queue/refunds/approve${here}`} method="post">
                <input type="hidden" name="matchId" value={row.matchId} />
                <button type="submit" className="btn btn-outline">
                  Review refund
                </button>
              </form>
            ) : null}
            {row.approval && !row.refund ? (
              <form action="/api/queue/refunds/execute" method="post">
                <input type="hidden" name="approvalId" value={row.approval.id} />
                <button type="submit" className="btn">
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
          <details>
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
          </details>
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

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ message?: string | string[]; sig?: string | string[] }> }) {
  const session = await currentSession();
  if (!session) redirect("/");
  const { rows, shop, coverage, pendingLiveSales, unidentified } = await loadQueue(getDb(), session.shopId, session.sessionId);
  // A session can outlast its shop, which is deleted with its data. There is no queue left to show.
  if (!shop) redirect("/");
  const params = await searchParams;
  const message = trustedMessage(secret("SESSION_SECRET"), params.message, params.sig);
  const shopName = shop.name;
  const shopKind = shop.kind;
  const { cards, cleared, unrelated } = toCards(rows);
  const agentReady = agentConfigured();
  const counts = queueCounts({ cards, cleared, unrelated, recallsChecked: coverage?.recallsChecked ?? null });

  return (
    <main className="page">
      <header className="page-head">
        <h1>{shopName}</h1>
        <span className="quiet">
          {counts.waiting} {counted(counts.waiting, "item waits", "items wait")} for you
        </span>
      </header>
      <p>Check each match, then approve what goes out. Nothing is sent without you.</p>
      {message ? (
        <p role="alert" className="alert">
          {message}
        </p>
      ) : null}
      {pendingLiveSales > 0 ? <WatchForSale /> : null}
      <div className="stats" data-testid="stats">
        <div className="stat">
          <span className="stat-value">{counts.recallsChecked ?? "None"}</span>
          <span className="stat-label">{counted(counts.recallsChecked ?? 0, "Recall checked", "Recalls checked")}</span>
        </div>
        <div className="stat stat-MATCH">
          <span className="stat-value">{counts.matched}</span>
          <span className="stat-label">Matched</span>
        </div>
        <div className="stat stat-SCOPE_GAP">
          <span className="stat-value">{counts.scopeGaps}</span>
          <span className="stat-label">{counted(counts.scopeGaps, "Scope gap", "Scope gaps")}</span>
        </div>
        <div className="stat stat-CLEARED">
          <span className="stat-value">{counts.cleared}</span>
          <span className="stat-label">Cleared</span>
        </div>
      </div>
      <p className="note">
        {coverage ? <span data-testid="coverage">{coverageLine(coverage)} </span> : null}
        {shopKind === "DEMO" ? "Dates marked seeded are demo data. " : null}
        {agentReady ? null : <span data-testid="agent-unavailable">Claude check unavailable.</span>}
      </p>
      <noscript>
        <style>{`.cards > .window, .narrow-only { display: block !important; } .cards-hint { display: none !important; }`}</style>
      </noscript>
      {/* Above the grid, because the grid draws late: anything below it gets pushed off screen after the browser has scrolled to it. */}
      <section data-testid="needs" className="cards">
        <h2 className="section-title narrow-only">Needs review</h2>
        {cards.map((card) => (
          <Card key={card.lead.matchId} card={card} shopName={shopName} shopKind={shopKind} agentReady={agentReady} />
        ))}
      </section>
      <MatchGridLoader rows={[...gridRows(rows, cards), ...unidentifiedRows(unidentified)]} />
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
          <p>This deletes your file, its checks and any messages you prepared, for good.</p>
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
