// A title and model anyone supplies, checked against real CPSC recalls with the same rules a shop's sales get. Nothing is
// stored, and PayPal isn't involved: the text comes from the caller and the recalls are public.
import { missingRecallYears } from "../cpsc/load";
import type { Queryable } from "../db/types";
import { CHECK_FROM, MIN_SIMILARITY } from "./run";
import { modelTokens, verdictFor, type VerdictResult } from "./verdict";
import type { Recall } from "../cpsc/schema";

export const MAX_TITLE = 200;
export const MAX_MODEL = 60;
/** Enough to read. The candidates are ranked before the rules run, so the closest are the ones judged. */
const MAX_CANDIDATES = 40;
const MAX_RESULTS = 10;

export interface TextCheck {
  title: string;
  model: string;
}

export type TextCheckResult = {
  recallNumber: string;
  title: string;
  recallDate: string;
  url: string | null;
  verdict: "MATCH" | "SCOPE_GAP";
  strength: VerdictResult["strength"];
  reason: string;
  missing: string[];
};

export interface TextCheckAnswer {
  results: TextCheckResult[];
  /** Came near and were ruled out by the rules, so they aren't listed. */
  cleared: number;
  checked: { recalls: number; from: string | null; to: string | null; yearsMissing: number[] };
  note: string;
}

const NOTE = "Rules comparing your text with CPSC's public records. A result names a recall to read, not a finding about your item. Only CPSC's notice and the item itself can settle it.";

/** The text to check, or what's wrong with it. A model alone is enough, because a model is what identifies a product. */
export function readTextCheck(rawTitle: string | null | undefined, rawModel: string | null | undefined): TextCheck | { error: string } {
  const title = (rawTitle ?? "").trim();
  const model = (rawModel ?? "").trim();
  if (title.length > MAX_TITLE) return { error: `title can be at most ${MAX_TITLE} characters, and model at most ${MAX_MODEL}` };
  if (model.length > MAX_MODEL) return { error: `title can be at most ${MAX_TITLE} characters, and model at most ${MAX_MODEL}` };
  if (title.length < 2 && model.length < 2) return { error: "give a product title in title, a model number in model, or both" };
  return { title, model };
}

export async function checkText(db: Queryable, input: TextCheck, today: string): Promise<TextCheckAnswer> {
  const text = `${input.title} ${input.model}`.trim();
  const { rows: counted } = await db.query<{ n: string; first: string | null; last: string | null }>(
    "select count(*)::text as n, min(recall_date)::text as first, max(recall_date)::text as last from recalls where recall_date >= $1::date",
    [CHECK_FROM],
  );
  const yearsMissing = await missingRecallYears(db, Number(CHECK_FROM.slice(0, 4)), today);
  const { rows } = await db.query<Pick<Recall, "title" | "description" | "products" | "retailers"> & { recall_number: string; recall_date: string; url: string | null }>(
    `with near as (
       select recall_id,
         word_similarity($2, lower(title || ' ' || coalesce((select string_agg(p->>'name', ' ') from jsonb_array_elements(products) p), ''))) as similarity,
         exists (select 1 from jsonb_array_elements_text($3::jsonb) as t(token) where position(t.token in upper(title || ' ' || description)) > 0) as model_hit
       from recalls where recall_date >= $1::date
     )
     select r.recall_number, r.recall_date::text as recall_date, r.url, r.title, r.description, r.products, r.retailers
     from near n join recalls r using (recall_id)
     where n.model_hit or n.similarity >= $4
     order by n.model_hit desc, n.similarity desc, r.recall_number desc
     limit $5`,
    [CHECK_FROM, text.toLowerCase(), JSON.stringify(modelTokens(text.toUpperCase())), MIN_SIMILARITY, MAX_CANDIDATES],
  );
  const judged = rows.map((recall) => ({ recall, verdict: verdictFor(recall, { title: text, description: "" }) }));
  const results = judged
    .filter((j) => j.verdict.verdict !== "CLEARED")
    .sort((a, b) => Number(b.verdict.verdict === "MATCH") - Number(a.verdict.verdict === "MATCH"))
    .slice(0, MAX_RESULTS)
    .map(({ recall, verdict }) => ({
      recallNumber: recall.recall_number,
      title: recall.title,
      recallDate: recall.recall_date,
      url: recall.url,
      verdict: verdict.verdict as TextCheckResult["verdict"],
      strength: verdict.strength,
      reason: verdict.reason,
      missing: verdict.missing,
    }));
  return {
    results,
    cleared: judged.filter((j) => j.verdict.verdict === "CLEARED").length,
    checked: { recalls: Number(counted[0].n), from: counted[0].first, to: counted[0].last, yearsMissing },
    note: NOTE,
  };
}
