import { notFound } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { familyView, type CheckResult } from "@/server/notice/store";
import { noticeIdFromToken } from "@/server/notice/token";
import { secret } from "@/server/web/http";

export const dynamic = "force-dynamic";

function ResultText({ result, url }: { result: CheckResult; url: string }) {
  if (result === "MATCHES") {
    return (
      <p data-testid="check-answer" className="result">
        Yours looks like the recalled product. Please stop using it and follow the steps below.
      </p>
    );
  }
  if (result === "DOESNT_MATCH") {
    return (
      <p data-testid="check-answer" className="result">
        Your answers do not match the details of this recall. This does not show that the product is safe. If you are unsure, stop using it and check here: <a href={url}>{url}</a>
      </p>
    );
  }
  return (
    <p data-testid="check-answer" className="result">
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
    <main className="family">
      <div className="column">
        <h1>{isCheck ? "Please check one thing" : "This product was recalled"}</h1>
        <p className="product">{view.product}</p>
        {view.image ? (
          <figure className="photo">
            {/* eslint-disable-next-line @next/next/no-img-element -- CPSC's own photo, served by CPSC */}
            <img src={view.image.url} alt={view.image.caption} referrerPolicy="no-referrer" />
            <figcaption>{view.image.caption}. Photo from CPSC.</figcaption>
          </figure>
        ) : null}

        {view.expired ? <p data-testid="expired">This link no longer takes answers. What CPSC says about this product is below.</p> : null}

        {isCheck && view.answerOpen && view.question && !view.expired ? (
          <section className="question">
            <p data-testid="question" className="question-text">
              {view.question.question}
            </p>
            <p>Until you can check, stop using it and keep it out of children&apos;s reach.</p>
            <form action={action} method="post">
              <input type="hidden" name="asked" value={view.question.question} />
              {view.question.kind === "model" ? (
                <>
                  <label className="field">
                    Model number <input name="answer" autoComplete="off" required />
                  </label>
                  <div className="answers">
                    <button type="submit" className="btn big">
                      Check
                    </button>
                    <button type="submit" className="btn btn-outline" name="answer" value="not_sure" formNoValidate>
                      I can&apos;t find it
                    </button>
                  </div>
                </>
              ) : (
                <div className="answers">
                  <button type="submit" className="btn btn-outline" name="answer" value="yes">
                    Yes
                  </button>
                  <button type="submit" className="btn btn-outline" name="answer" value="no">
                    No
                  </button>
                  <button type="submit" className="btn btn-outline" name="answer" value="not_sure">
                    Not sure
                  </button>
                </div>
              )}
            </form>
          </section>
        ) : null}
        {view.result ? <ResultText result={view.result} url={view.recallUrl} /> : null}

        <h2>The hazard, in CPSC&apos;s words</h2>
        <div className="hazard">
          {view.hazards.map((h) => (
            <p key={h}>{h}</p>
          ))}
        </div>
        <h2>What to do, in CPSC&apos;s words</h2>
        {view.remedies.map((r) => (
          <p key={r}>{r}</p>
        ))}
        <p>
          <a href={view.recallUrl}>Open the maker&apos;s recall page</a>
        </p>

        {view.stopped ? (
          <p id="stopped" data-testid="stopped" className="result">
            You&apos;ve told {view.shopName} you stopped using it. This does not finish the recall steps. Keep it out of children&apos;s reach and follow the steps above.
          </p>
        ) : !view.expired ? (
          <form action={action} method="post" style={{ marginTop: 24 }}>
            <input type="hidden" name="action" value="stopped" />
            <button type="submit" className="btn big">
              I&apos;ve stopped using it
            </button>
          </form>
        ) : null}
        <footer>
          <p>Recall details come from the U.S. CPSC. This page was sent by {view.shopName}.</p>
        </footer>
      </div>
    </main>
  );
}
