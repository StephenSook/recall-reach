import type { SellerAnswer } from "@/server/match/sellerAnswers";

const SAID: Record<SellerAnswer, string> = { SAME_PRODUCT: "the recalled product", DIFFERENT_PRODUCT: "a different product" };

/** A plain form: no script, nothing added to the queue's bundle. */
export function SellerAnswerForm({ matchId, answer, demo }: { matchId: string; answer: SellerAnswer | null; demo: boolean }) {
  return (
    <form method="post" action="/api/queue/answers" data-testid="seller-answer">
      <input type="hidden" name="matchId" value={matchId} />
      <p>{answer ? `You said this is ${SAID[answer]}.` : "Is this the recalled product?"}</p>
      <div className="actions">
        {answer !== "SAME_PRODUCT" ? (
          <button type="submit" name="answer" value="SAME_PRODUCT" className="btn btn-outline">
            {answer ? "No, it is the recalled product" : "Yes, it is"}
          </button>
        ) : null}
        {answer !== "DIFFERENT_PRODUCT" ? (
          <button type="submit" name="answer" value="DIFFERENT_PRODUCT" className="btn btn-outline">
            {answer ? "No, it is a different product" : "No, it is different"}
          </button>
        ) : null}
      </div>
      <p>
        <small>
          This tests the matcher and changes nothing on this card.{" "}
          {demo ? "A demo shop's answer is never counted." : "Kept with your shop: the recall number, this title and your answer."}
        </small>
      </p>
    </form>
  );
}
