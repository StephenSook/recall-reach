import Link from "next/link";
import type { ItemAnswer, RecallToRead } from "./itemAnswer";

function RecallLinks({ recalls }: { recalls: RecallToRead[] }) {
  if (recalls.length === 0) return null;
  return (
    <ul className="recall-links">
      {recalls.map((r) => (
        <li key={r.recallNumber}>
          <Link href={`/recall/${encodeURIComponent(r.recallNumber)}`}>
            <strong>{r.recallNumber}</strong> {r.title}
          </Link>
          {r.modelNamed ? <small>Model {r.modelNamed} is named in this recall.</small> : null}
          {r.missing ? <small>Missing: {r.missing}</small> : null}
        </li>
      ))}
    </ul>
  );
}

/** One typed item's answer. Every recall it names links to CPSC's words, here. */
export function ItemAnswerView({ answer, checked }: { answer: ItemAnswer; checked: string }) {
  return (
    <section className="item-answer" data-testid="item-answer" data-kind={answer.kind}>
      <p className="note">Checked: {checked}</p>
      <p className="item-says" role="status">
        {answer.says}
      </p>
      {answer.sameKind ? <p>{answer.sameKind}</p> : null}
      {answer.kind === "NOTHING" || answer.kind === "NOT_NAMED" ? (
        <p>
          Check the model on the label at <a href="https://www.cpsc.gov/Recalls">cpsc.gov/Recalls</a>.
        </p>
      ) : null}
      {answer.kind === "UNFINISHED" ? (
        <p className="note">
          CPSC&apos;s own list is at <a href="https://www.cpsc.gov/Recalls">cpsc.gov/Recalls</a>.
        </p>
      ) : null}
      <RecallLinks recalls={answer.matches} />
      {answer.matches.length > 0 && answer.toRead.length > 0 ? <p className="item-also">Can&apos;t tell yet:</p> : null}
      <RecallLinks recalls={answer.toRead} />
      {answer.folded.length > 0 ? (
        <details className="check-details" data-testid="same-kind">
          <summary>{answer.folded.length === 1 ? "Show it" : `Show the ${answer.folded.length}`}</summary>
          <RecallLinks recalls={answer.folded} />
        </details>
      ) : null}
      {answer.further ? <p className="note">{answer.further}</p> : null}
      {answer.gap ? <p className="note">{answer.gap}</p> : null}
    </section>
  );
}
