// A person accepts or rejects the questions Claude wrote. Accepting is what lets a "no" count against a recall.
import type { Queryable } from "../db/types";
import { QUESTION_VERSION } from "./questionStore";

export interface PendingQuestion {
  recallNumber: string;
  product: string;
  url: string;
  question: string;
  evidence: string;
  everyRecalledUnit: boolean;
}

/** Questions on CPSC's current text that no person has read yet: the ones named in `first`, then the newest recalls. */
export async function pendingQuestions(db: Queryable, opts: { limit: number; first?: string[] }): Promise<PendingQuestion[]> {
  const { rows } = await db.query<{ recall_number: string; products: { name: string }[]; title: string; url: string; question: string; evidence: string; every_recalled_unit: boolean }>(
    `select r.recall_number, r.products, r.title, r.url, q.question, q.evidence, q.every_recalled_unit
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
  }));
}

/** False if nothing changed: the words are not the ones this person read, or it was already decided. */
export async function reviewQuestion(db: Queryable, input: { recallNumber: string; question: string; decision: "ACCEPTED" | "REJECTED" }): Promise<boolean> {
  const { rows } = await db.query(
    `update recall_questions q set review = $1, reviewed_at = now()
     from recalls r
     where r.recall_id = q.recall_id and r.raw_sha256 = q.recall_sha256 and r.recall_number = $2
       and q.agent_version = $3 and q.question = $4 and q.review is null
     returning q.recall_id`,
    [input.decision, input.recallNumber, QUESTION_VERSION, input.question],
  );
  return rows.length > 0;
}
