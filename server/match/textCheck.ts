// A title and model anyone supplies, checked against real CPSC recalls with the same rules a shop's sales get. Nothing is
// stored, and PayPal isn't involved: the text comes from the caller and the recalls are public.
import { missingRecallYears } from "../cpsc/load";
import { cpscPhoto } from "../cpsc/photo";
import type { Queryable } from "../db/types";
import { CHECK_FROM, MIN_SIMILARITY } from "./run";
import { editDistance, modelTokens, namesProductLine, nearMissCodes, normalizeModel, type VerdictResult, verdictFor, words } from "./verdict";
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
  /** Its text has what was given: all of it, or a word few recalls have, so it could be this item. Otherwise it only shares a kind of product. Only set when no recall is tied to the text. */
  sharesWords: boolean;
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
  /**
   * Recalls past the results whose text has what was given, as sharesWords reads it. The rules clear what they can't tie to a
   * product, so a maker or one product word given alone ends up here. Only looked for when no recall is tied to the text.
   */
  mentioned: { recalls: { recallNumber: string; title: string }[]; total: number };
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
/** A word this few recalls have says something on its own, about 3 in 1,000 of those held: Bodum does, stroller and wooden don't. */
const RARE_WORD_SHARE = 0.003;
const MAX_WORDS_SOUGHT = 8;

/** Neighbouring words that read as one code when joined: BRZ 0083 is BRZ0083. These only widen what gets read: the rules still decide. */
function joinedCodes(text: string): string[] {
  const parts = text.toUpperCase().split(/\s+/).map(normalizeModel).filter(Boolean);
  return parts.slice(1).map((part, i) => parts[i] + part).filter((t) => t.length >= 4 && /\d/.test(t) && /[A-Z]/.test(t));
}

const plainText = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** What to look for in CPSC's text, which has every form of a word: presses finds press, and babies finds baby. Too wide is safe here. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

const soughtWords = (text: string) => [...new Set(plainText(text).split(" ").filter((w) => words(w).size > 0).map(stem))].slice(0, MAX_WORDS_SOUGHT);

/**
 * Typed words no recall's text has, so they could be slips. A word another recall has isn't one, however close it reads: chair
 * isn't a slip for hair.
 */
async function wordsNoRecallHas(db: Queryable, typed: string[]): Promise<string[]> {
  if (typed.length === 0) return [];
  const { rows } = await db.query<{ word: string }>(
    `select s.word from unnest($2::text[]) as s(word)
     where not exists (select 1 from recalls r where r.recall_date >= $1::date and position(s.word in lower(r.title || ' ' || r.description || ' ' || r.products::text)) > 0)`,
    [CHECK_FROM, typed],
  );
  return rows.map((r) => r.word);
}

/** One letter wrong in a word of the recall's name: Zorbx for Zorbex, swng for swing. */
function typoOfRecallName(unseen: string[], recall: Pick<Recall, "title" | "products">): boolean {
  const names = [...words(`${recall.title} ${recall.products.map((p) => p.name).join(" ")}`)];
  return unseen.some((w) => names.some((n) => Math.abs(n.length - w.length) <= 1 && editDistance(n, w) <= 1));
}

/**
 * Recalls whose text could be what was typed: the whole of it in a row, every word of it, all but one of four or more, or a word
 * few recalls have. Reading the text itself, so it doesn't lean on the rules, which clear what they can't tie to a product. Separators become spaces, so the
 * pieces of a date don't read as one number.
 */
async function recallsWithTypedWords(db: Queryable, text: string, sought: string[]): Promise<{ recallNumber: string; title: string }[]> {
  const phrase = plainText(text);
  if (phrase.length < 2) return [];
  const { rows } = await db.query<{ recall_number: string; title: string }>(
    `with sought as (select unnest($2::text[]) as word),
     held as (
       select r.recall_number, r.title, r.recall_date,
         ' ' || regexp_replace(lower(r.title || ' ' || r.description || ' ' || coalesce((select string_agg(p->>'name', ' ') from jsonb_array_elements(r.products) p), '')), '[^a-z0-9]+', ' ', 'g') || ' ' as text
       from recalls r where r.recall_date >= $1::date
     ),
     rarity as (select s.word, count(h.recall_number) as recalls from sought s left join held h on position(s.word in h.text) > 0 group by s.word)
     select h.recall_number, h.title
     from held h
     where position(' ' || $3 || ' ' in h.text) > 0
       or (
         cardinality($2::text[]) > 0
         and (
           (select count(*) from sought s where position(s.word in h.text) = 0) <= (case when cardinality($2::text[]) >= 4 then 1 else 0 end)
           or exists (select 1 from rarity x where x.recalls <= greatest(1, ceil((select count(*) from held) * $4::float8)) and position(x.word in h.text) > 0)
         )
       )
     order by h.recall_date desc, h.recall_number desc`,
    [CHECK_FROM, sought, phrase, RARE_WORD_SHARE],
  );
  return rows.map((r) => ({ recallNumber: r.recall_number, title: r.title }));
}

export async function checkText(
  db: Queryable,
  input: TextCheck,
  today: string,
  opts: { maxCandidates?: number; maxResults?: number; mentions?: boolean } = {},
): Promise<TextCheckAnswer> {
  const text = `${input.title} ${input.model}`.trim();
  // A number typed alone counts as the model, whichever field it went in.
  const typedModel = normalizeModel(input.model) || (/^[\d\s.-]+$/.test(input.title) ? normalizeModel(input.title) : "");
  const { rows: counted } = await db.query<{ n: string; first: string | null; last: string | null }>(
    "select count(*)::text as n, min(recall_date)::text as first, max(recall_date)::text as last from recalls where recall_date >= $1::date",
    [CHECK_FROM],
  );
  const yearsMissing = await missingRecallYears(db, Number(CHECK_FROM.slice(0, 4)), today);
  // Compared with the punctuation out of both sides, as the rules do: BRZ-0083 and BRZ 0083 are BRZ0083.
  const tokens = [...new Set([...modelTokens(text.toUpperCase()).map(normalizeModel), ...joinedCodes(text), typedModel])].filter((t) => t.length >= 3);
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

  const kept = judged.filter((j) => j.verdict.verdict !== "CLEARED");
  const looking = opts.mentions !== false && !kept.some((j) => j.tied);
  const sought = soughtWords(text);
  const withWords = looking ? await recallsWithTypedWords(db, text, sought) : [];
  const hasWords = new Set(withWords.map((r) => r.recallNumber));
  // Only among recalls that came near, which is where trigrams put a slip. A recall found this way goes first in its list.
  const typos = new Set<string>();
  if (looking) {
    const unseen = await wordsNoRecallHas(db, [...words(text)].filter((w) => w.length >= 4).slice(0, MAX_WORDS_SOUGHT));
    for (const { recall } of judged) {
      if (typoOfRecallName(unseen, recall)) typos.add(recall.recall_number);
    }
  }
  const slips = judged.filter((j) => typos.has(j.recall.recall_number) && !hasWords.has(j.recall.recall_number));
  for (const number of typos) hasWords.add(number);
  // A cut-off list has to keep the recalls that could be this text, ahead of ones that only share a kind of product.
  const rank = (j: (typeof judged)[number]) => (j.verdict.verdict === "MATCH" ? 0 : j.tied ? 1 : hasWords.has(j.recall.recall_number) ? 2 : 3);
  const found = kept.sort((a, b) => rank(a) - rank(b));
  const foundNumbers = new Set(found.map((j) => j.recall.recall_number));
  const past = [...slips.map((j) => ({ recallNumber: j.recall.recall_number, title: j.recall.title })), ...withWords].filter((r) => !foundNumbers.has(r.recallNumber));
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
      sharesWords: hasWords.has(recall.recall_number),
      reason: verdict.reason,
      missing: verdict.missing,
    })),
    more: Math.max(0, found.length - limit),
    cleared: judged.filter((j) => j.verdict.verdict === "CLEARED").length,
    notJudged: Math.max(0, Number(rows[0]?.near ?? 0) - rows.length),
    mentioned: { recalls: past.slice(0, limit), total: past.length },
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
  checkText(db, { title: `${listing.brand ?? ""} ${listing.title}`.trim(), model: "" }, today, { maxResults: MAX_CANDIDATES, mentions: false });

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
