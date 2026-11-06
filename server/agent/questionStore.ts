// Reads the question Claude wrote for a recall. Kept apart from the writer, so the pages that read a question
// don't load the Claude client.
import type { Queryable } from "../db/types";

/** Goes up when the prompt or the guard changes, so a question written under older rules is written again. */
export const QUESTION_VERSION = "4";

/** Whether a key is set at all. Pages use this so they don't load the Claude client. A refused key shows up when it is used. */
export const agentConfigured = (env: Record<string, string | undefined> = process.env) => Boolean(env.ANTHROPIC_API_KEY?.trim());

export interface WrittenQuestion {
  question: string;
  /** The exact CPSC words it rests on. */
  evidence: string;
  /** Claude says every recalled unit has this trait and a person checked that, so a no would set the product apart. */
  everyRecalledUnit: boolean;
  /** A person read it and accepted it. */
  accepted: boolean;
}

/** Null if none was written for this exact CPSC text, or a person rejected it. */
export async function writtenQuestion(db: Queryable, recallSha256: string): Promise<WrittenQuestion | null> {
  const { rows } = await db.query<{ question: string; evidence: string; every_recalled_unit: boolean; review: string | null }>(
    `select question, evidence, every_recalled_unit and scope_confirmed as every_recalled_unit, review from recall_questions
     where recall_sha256 = $1 and agent_version = $2 and outcome = 'QUESTION' and review is distinct from 'REJECTED'`,
    [recallSha256, QUESTION_VERSION],
  );
  const q = rows[0];
  return q ? { question: q.question, evidence: q.evidence, everyRecalledUnit: q.every_recalled_unit, accepted: q.review === "ACCEPTED" } : null;
}
