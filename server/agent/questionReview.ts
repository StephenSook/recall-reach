// A person accepts or rejects the questions Claude wrote. Accepting is what lets a "no" count against a recall.
import type { Queryable } from "../db/types";
import { staleNoSql } from "../notice/store";
import { QUESTION_VERSION } from "./questionStore";

export interface PendingQuestion {
  recallNumber: string;
  product: string;
  url: string;
  question: string;
  evidence: string;
  /** Claude's claim, for a person to check against CPSC's text. It counts for nothing until they do. */
  everyRecalledUnit: boolean;
  /** CPSC's own description, so the reader can check more than the words Claude chose to quote. */
  description: string;
}

/** Questions on CPSC's current text that no person has read yet: the ones named in `first`, then the newest recalls. */
export async function pendingQuestions(db: Queryable, opts: { limit: number; first?: string[] }): Promise<PendingQuestion[]> {
  const { rows } = await db.query<{ recall_number: string; products: { name: string }[]; title: string; url: string; question: string; evidence: string; every_recalled_unit: boolean; description: string }>(
    `select r.recall_number, r.products, r.title, r.url, r.description, q.question, q.evidence, q.every_recalled_unit
     from recall_questions q join recalls r on r.recall_id = q.recall_id and r.raw_sha256 = q.recall_sha256
     where q.agent_version = $1 and q.outcome = 'QUESTION' and q.review is null
     order by (r.recall_number = any($2::text[])) desc, r.recall_date desc, r.recall_number desc
     limit $3`,
    [QUESTION_VERSION, opts.first ?? [], opts.limit],
  );
  return rows.map((r) => ({
    recallNumber: r.recall_number,
    product: r.products[0]?.name ?? r.title,
    url: r.url,
    question: r.question,
    evidence: r.evidence,
    everyRecalledUnit: r.every_recalled_unit,
    description: r.description,
  }));
}

/**
 * False if nothing changed: the words are not the ones this person read, or it was already decided.
 * Rejecting also takes the question off any message the family has not settled, in one statement, so a question a
 * person said is wrong is no longer asked. "Not sure" settles nothing, and nor does a no given on an older version of the recall. A real answer stays as the record of what was asked.
 */
export async function reviewQuestion(
  db: Queryable,
  input: { recallNumber: string; question: string; decision: "ACCEPTED" | "REJECTED"; scopeConfirmed?: boolean },
): Promise<boolean> {
  const { rows } = await db.query(
    `with decided as (
       update recall_questions q set review = $1, reviewed_at = now(), scope_confirmed = $5
       from recalls r
       where r.recall_id = q.recall_id and r.raw_sha256 = q.recall_sha256 and r.recall_number = $2
         and q.agent_version = $3 and q.question = $4 and q.review is null
       returning q.recall_id
     ), cleared as (
       update notices n set written_question = null
       from recall_matches m join recalls cr on cr.recall_id = m.recall_id
       where $1 = 'REJECTED' and m.id = n.match_id and m.recall_id in (select recall_id from decided)
         and n.written_question ->> 'question' = $4 and (n.check_result is null or n.check_open or ${staleNoSql("n.", "cr.raw_sha256")})
     )
     select recall_id from decided`,
    [input.decision, input.recallNumber, QUESTION_VERSION, input.question, input.decision === "ACCEPTED" && input.scopeConfirmed === true],
  );
  return rows.length > 0;
}
