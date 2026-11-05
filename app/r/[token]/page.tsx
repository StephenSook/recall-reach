import { notFound } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { familyView, type CheckResult } from "@/server/notice/store";
import { noticeIdFromToken } from "@/server/notice/token";
import { secret } from "@/server/web/http";

export const dynamic = "force-dynamic";

function ResultText({ result, url }: { result: CheckResult; url: string }) {
  if (result === "MATCHES") return <p data-testid="check-answer">Yours looks like the recalled product. Please stop using it and follow the steps below.</p>;
  if (result === "DOESNT_MATCH") {
    return (
      <p data-testid="check-answer">
        Your answers do not match the details of this recall. This does not show that the product is safe. If you are unsure, stop using it and check here: <a href={url}>{url}</a>
      </p>
    );
  }
  return (
    <p data-testid="check-answer">
      We can&apos;t tell if your item is included. Stop using it for now and keep it out of children&apos;s reach. Check the details and contact listed here: <a href={url}>{url}</a>
    </p>
  );
}

export default async function FamilyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const noticeId = noticeIdFromToken(secret("SESSION_SECRET"), token);
  const view = noticeId ? await familyView(getDb(), noticeId) : null;
  if (!view) notFound();
  const action = `/api/family/${token}`;
  const isCheck = view.kind === "CHECK_REQUEST";

  return (
    <main>
      <h1>{isCheck ? "Please check one thing" : "This product was recalled"}</h1>
      <p>{view.product}</p>

      {isCheck && !view.result && view.question ? (
        <section>
          <p data-testid="question">{view.question.question}</p>
          <form action={action} method="post">
            {view.question.kind === "model" ? (
              <>
                <label>
                  Model number <input name="answer" autoComplete="off" />
                </label>
                <button type="submit">Check</button>
              </>
            ) : (
              <>
                <button type="submit" name="answer" value="yes">
                  Yes
                </button>{" "}
                <button type="submit" name="answer" value="no">
                  No
                </button>{" "}
                <button type="submit" name="answer" value="not_sure">
                  Not sure
                </button>
              </>
            )}
          </form>
        </section>
      ) : null}
      {view.result ? <ResultText result={view.result} url={view.recallUrl} /> : null}

      <h2>The hazard, in CPSC&apos;s words</h2>
      {view.hazards.map((h) => (
        <p key={h}>{h}</p>
      ))}
      <h2>What to do, in CPSC&apos;s words</h2>
      {view.remedies.map((r) => (
        <p key={r}>{r}</p>
      ))}
      <p>
        <a href={view.recallUrl}>Open the maker&apos;s recall page</a>
      </p>

      {view.stopped ? (
        <p data-testid="stopped">
          You&apos;ve told {view.shopName} you stopped using it. This does not finish the recall steps. Keep it out of children&apos;s reach and follow the steps above.
        </p>
      ) : (
        <form action={action} method="post">
          <input type="hidden" name="action" value="stopped" />
          <button type="submit">I&apos;ve stopped using it</button>
        </form>
      )}
      <footer>
        <p>Recall details come from the U.S. CPSC. This page was sent by {view.shopName}.</p>
      </footer>
    </main>
  );
}
