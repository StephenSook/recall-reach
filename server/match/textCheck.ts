// A title and model anyone supplies, checked against real CPSC recalls with the same rules a shop's sales get. Nothing is
// stored, and PayPal isn't involved: the text comes from the caller and the recalls are public.
import { missingRecallYears } from "../cpsc/load";
import { cpscPhoto } from "../cpsc/photo";
import type { Queryable } from "../db/types";
import { CHECK_FROM, MIN_SIMILARITY } from "./run";
import { modelTokens, namesProductLine, nearMissCodes, normalizeModel, type VerdictResult, verdictFor } from "./verdict";
import type { Recall } from "../cpsc/schema";

export const MAX_TITLE = 200;
export const MAX_MODEL = 60;
/** Well past anything real text comes near. Model hits rank first, so one can't be crowded out, and the answer says if any weren't judged. */
const MAX_CANDIDATES = 200;
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
  /** The text has this recall's model, a code close to it, or its maker and product line. Otherwise it only shares a kind of product. */
  tiedToRecall: boolean;
  reason: string;
  missing: string[];
};

export interface TextCheckAnswer {
  results: TextCheckResult[];
  /** Found, past what is listed. */
  more: number;
  /** Came near and were ruled out by the rules, so they aren't listed. */
  cleared: number;
  /** Came near but weren't judged, because too many did. Above zero, an empty list doesn't mean nothing was found. */
  notJudged: number;
  /** Ruled out, but from the same maker. A maker typed alone ends up here, and that isn't the same as nothing coming near. */
  sameMaker: { recallNumber: string; title: string }[];
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

/** Numbers that stand alone in a recall's text. Punctuation separates them, so the pieces of a phone number stay pieces. */
const standaloneNumbers = (text: string) => new Set(text.split(/[^A-Za-z0-9]+/));

/** A model is only digits on some recalls, and the rules read codes with letters. Long enough not to be a year or a count. */
const MIN_DIGITS_MODEL = 5;

export async function checkText(
  db: Queryable,
  input: TextCheck,
  today: string,
  opts: { maxCandidates?: number; maxResults?: number } = {},
): Promise<TextCheckAnswer> {
  const text = `${input.title} ${input.model}`.trim();
  const typedModel = normalizeModel(input.model);
  const { rows: counted } = await db.query<{ n: string; first: string | null; last: string | null }>(
    "select count(*)::text as n, min(recall_date)::text as first, max(recall_date)::text as last from recalls where recall_date >= $1::date",
    [CHECK_FROM],
  );
  const yearsMissing = await missingRecallYears(db, Number(CHECK_FROM.slice(0, 4)), today);
  // Compared with the punctuation out of both sides, as the rules do: BRZ-0083 and BRZ 0083 are BRZ0083.
  const tokens = [...new Set([...modelTokens(text.toUpperCase()).map(normalizeModel), typedModel])].filter((t) => t.length >= 3);
  const { rows } = await db.query<Pick<Recall, "title" | "description" | "products" | "retailers"> & { recall_number: string; recall_date: string; url: string | null; near: string }>(
    `with near as (
       select recall_id,
         word_similarity($2, lower(title || ' ' || coalesce((select string_agg(p->>'name', ' ') from jsonb_array_elements(products) p), ''))) as similarity,
         exists (select 1 from jsonb_array_elements_text($3::jsonb) as t(token) where position(t.token in regexp_replace(upper(title || ' ' || description), '[^A-Z0-9]', '', 'g')) > 0) as model_hit
       from recalls where recall_date >= $1::date
     )
     select r.recall_number, r.recall_date::text as recall_date, r.url, r.title, r.description, r.products, r.retailers, count(*) over ()::text as near
     from near n join recalls r using (recall_id)
     where n.model_hit or n.similarity >= $4
     order by n.model_hit desc, n.similarity desc, r.recall_number desc
     limit $5`,
    [CHECK_FROM, text.toLowerCase(), JSON.stringify(tokens), MIN_SIMILARITY, opts.maxCandidates ?? MAX_CANDIDATES],
  );
  const judged = rows.map((recall) => {
    const verdict = verdictFor(recall, { title: text, description: "" });
    const tied = verdict.verdict === "MATCH" || verdict.strength === "CONFIRMED" || (verdict.strength === "BRAND" && namesProductLine(verdict.matched)) || (verdict.verdict !== "CLEARED" && nearMissCodes(`${recall.title} ${recall.description}`, text).length > 0);
    const digitsOnly = /^\d+$/.test(typedModel) && typedModel.length >= MIN_DIGITS_MODEL;
    if (verdict.verdict === "CLEARED" && digitsOnly && standaloneNumbers(`${recall.title} ${recall.description}`).has(typedModel)) {
      return {
        recall,
        tied: true,
        verdict: {
          ...verdict,
          verdict: "SCOPE_GAP" as const,
          reason: `CPSC's text for this recall has the number ${typedModel}. Read it to see whether that is your product's model.`,
          missing: ["whether the number you gave is this product's model"],
        },
      };
    }
    return { recall, tied, verdict };
  });
  // A cut-off list has to keep the recalls that name this text, ahead of ones that only share a kind of product.
  const rank = (j: (typeof judged)[number]) => (j.verdict.verdict === "MATCH" ? 0 : j.tied ? 1 : 2);
  const found = judged
    .filter((j) => j.verdict.verdict !== "CLEARED")
    .sort((a, b) => rank(a) - rank(b));
  const limit = opts.maxResults ?? MAX_RESULTS;
  return {
    results: found.slice(0, limit).map(({ recall, tied, verdict }) => ({
      recallNumber: recall.recall_number,
      title: recall.title,
      recallDate: recall.recall_date,
      url: recall.url,
      verdict: verdict.verdict as TextCheckResult["verdict"],
      strength: verdict.strength,
      tiedToRecall: tied,
      reason: verdict.reason,
      missing: verdict.missing,
    })),
    more: Math.max(0, found.length - limit),
    cleared: judged.filter((j) => j.verdict.verdict === "CLEARED").length,
    notJudged: Math.max(0, Number(rows[0]?.near ?? 0) - rows.length),
    sameMaker: judged
      .filter((j) => j.verdict.verdict === "CLEARED" && j.verdict.strength === "BRAND")
      .slice(0, limit)
      .map(({ recall }) => ({ recallNumber: recall.recall_number, title: recall.title })),
    checked: { recalls: Number(counted[0].n), from: counted[0].first, to: counted[0].last, yearsMissing },
    note: NOTE,
  };
}

/** The results tied to one recall. The rest only share a kind of product with it, as any high chair does with every recalled high chair. */
export const namingResults = (answer: Pick<TextCheckAnswer, "results">) => answer.results.filter((r) => r.tiedToRecall);

export type ListingCheck = "NAMES_A_RECALL" | "NO_MATCH_FOUND" | "COULD_NOT_FINISH";

/** Whether a listing may be offered. Only NO_MATCH_FOUND may. Unsure never reads as clear. */
export function readListingCheck(answer: TextCheckAnswer, listing: { brand: string | null }): ListingCheck {
  if (namingResults(answer).length > 0 || answer.more > 0) return "NAMES_A_RECALL";
  if (answer.notJudged > 0 || answer.checked.yearsMissing.length > 0) return "COULD_NOT_FINISH";
  // With no maker named, nothing separates this from a recall of the same kind of product.
  return !listing.brand && answer.results.length > 0 ? "COULD_NOT_FINISH" : "NO_MATCH_FOUND";
}

/** Every result, and the listing's whole text: cutting it short could drop the model that names a recall. */
export const checkListing = (db: Queryable, listing: { title: string; brand: string | null }, today: string) =>
  checkText(db, { title: `${listing.brand ?? ""} ${listing.title}`.trim(), model: "" }, today, { maxResults: MAX_CANDIDATES });

const RECALL_NUMBER = /^[A-Za-z0-9-]{1,16}$/;

export const isRecallNumber = (text: string) => RECALL_NUMBER.test(text);

/** CPSC's public record for one recall number. Holds nothing about a shop, a sale or a buyer. */
export async function readPublicRecall(db: Queryable, recallNumber: string) {
  const { rows } = await db.query<{ recall_number: string; title: string; recall_date: string; url: string; description: string; products: { name: string; model: string; type: string | null; units: string | null }[]; hazards: string[]; remedies: string[]; images: { url: string; caption: string }[] }>(
    "select recall_number, title, recall_date::text as recall_date, url, description, products, hazards, remedies, images from recalls where recall_number = $1 order by recall_date desc limit 1",
    [recallNumber],
  );
  const r = rows[0];
  if (!r) return { found: false as const, note: "No such recall is held here. That says nothing about a product: it does not mean a recall doesn't exist, and not that a product is safe." };
  return { found: true as const, recallNumber: r.recall_number, title: r.title, recallDate: r.recall_date, url: r.url, description: r.description, products: r.products, hazards: r.hazards, remedies: r.remedies, image: cpscPhoto(r.images) };
}
