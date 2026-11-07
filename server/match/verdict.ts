// The matcher's deterministic core. It reads public CPSC text and shop-owned text, and runs locally.
//
//   MATCH      the shop's text shows the recalled model, or for a one-model recall, the same brand and
//              line with the printed look CPSC describes.
//   SCOPE_GAP  related, but the text cannot show whether this unit is covered. This is the common case:
//              CPSC's structured Model field is empty on all 934 records of 2025-26.
//   CLEARED    a sibling model CPSC did not list, sold before first sale, or sharing at most one
//              product word with no brand named.
//
// A wrong CLEARED is the worst outcome here, so anything uncertain lands in SCOPE_GAP. There is no vendor
// field, and a shop's title may simply leave the brand out, so a title without the brand that shares two
// product words stays a gap. Its strength says how little that is: it is not enough to contact a family.
import type { Recall } from "../cpsc/schema";
import { firstSaleMonth } from "../cpsc/retailText";

export type Verdict = "MATCH" | "SCOPE_GAP" | "CLEARED";
export type SalePath = "NOTICE_ONLY" | "REVIEW" | "REFUND_ELIGIBLE";
/** What the two texts share, strongest first. A decision about outreach reads this, not the verdict alone. */
export type Strength = "CONFIRMED" | "BRAND" | "PRODUCT_WORDS" | "NO_SHARED_WORDS";

export interface VerdictResult {
  verdict: Verdict;
  strength: Strength;
  /** Evidence: what the shop's text and the recall share. */
  matched: string[];
  /** What the shop's text would need to show. Only for SCOPE_GAP. */
  missing: string[];
  reason: string;
}

export interface MatchCandidate {
  title: string;
  description?: string;
  orderedOn?: string;
}

const COMPANY_WORDS = new Set(["enterprises", "enterprise", "inc", "llc", "ltd", "corp", "corporation", "company", "co", "international", "group"]);
const STOP_WORDS = new Set(
  "a an and are as at be been by can for from has have in into is it its of on or that the their these they this to was were which with both each other only recall recalled recalls involves product products unit units model models number numbers printed label located sold".split(" "),
);
const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:V|W|KW|BTU|BTUS|MAH|OZ|FT|IN|MM|CM|ML|L|GB|TB|HZ|LB|LBS|PCS|PC|PK|X|D|K|AH|A|QT|CC|HP|G)$/;
// From the EDA's identifier rule: an upper-case token with a digit and a letter, 4 or more characters.
// Tested token by token, on bounded text, so a long shop title cannot make the match slow.
const MODEL_TOKEN = /^(?=[A-Z0-9_./-]*\d)(?=[A-Z0-9_./-]*[A-Z])[A-Z0-9][A-Z0-9_./-]{2,}[A-Z0-9]$/;
const MAX_TEXT = 4000;
const MAX_TOKEN = 40;

/** The recalling firm, from CPSC's "<Firm> Recalls ..." title, without company words. */
export function brandOf(title: string): string | null {
  const m = /^(.+?)\s+Recalls?\s/.exec(title);
  if (!m) return null;
  const firm = m[1].split(",")[0].trim();
  const words = firm.split(/\s+/).filter((w) => !COMPANY_WORDS.has(w.toLowerCase().replace(/\.$/, "")));
  // "Little Loves & Co." loses "Co.", and the "&" that joined it goes too.
  while (/^(?:&|and)$/i.test(words.at(-1) ?? "")) words.pop();
  return words.length > 0 ? words.join(" ") : null;
}

export function modelTokens(text: string, maxToken = MAX_TOKEN): string[] {
  const found = new Set<string>();
  for (const raw of text.slice(0, MAX_TEXT).split(/[^A-Za-z0-9_./-]+/)) {
    const token = raw.replace(/[._/-]+$/, "");
    if (token.length <= maxToken && MODEL_TOKEN.test(token) && !UNIT_TOKEN.test(token)) found.add(token);
  }
  return [...found].sort();
}

/** Punctuation does not separate models: BRZ-0083 and BRZ.0083 are BRZ0083. */
export const normalizeModel = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");
/** Letters a typed model is easily mistaken for: BRZOO83 is probably BRZ0083. */
export const unconfuse = (t: string) => t.replace(/O/g, "0").replace(/[IL]/g, "1");

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/** The model with only separators between its characters ("BRZ 0083"), and no extra character on either side. */
export function writtenApart(model: string): RegExp {
  const body = [...normalizeModel(model)].join("[\\s._/-]*");
  // A suffix joined by punctuation makes it another code: PAPA03001AI-X isn't PAPA03001AI. A space doesn't.
  return new RegExp(`(?<![A-Z0-9])(?<![A-Z0-9][._/-])${body}(?![A-Z0-9])(?![._/-][A-Z0-9])`);
}

/** Same letters up front and about the same length, so a code like X200 does not count as a sibling. */
function isSiblingModel(token: string, listed: string[]): boolean {
  const prefix = (t: string) => /^[A-Z]*/.exec(t)?.[0] ?? "";
  const t = normalizeModel(token);
  return listed.some((m) => {
    const n = normalizeModel(m);
    return prefix(n) !== "" && prefix(n) === prefix(t) && Math.abs(n.length - t.length) <= 2;
  });
}

/** Contains a listed model, is contained by one, or is one small slip from one. Possibly the same unit. */
export function isVariantOf(token: string, listed: string[]): boolean {
  const t = unconfuse(normalizeModel(token));
  return listed.some((m) => {
    const n = unconfuse(normalizeModel(m));
    return t.includes(n) || n.includes(t) || (Math.abs(t.length - n.length) <= 1 && editDistance(t, n) <= 1);
  });
}

/** The longest stretch of characters in a row that two codes share. */
function longestRun(a: string, b: string): string {
  let best = "";
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = previous[j - 1] + 1;
        if (row[j] > best.length) best = a.slice(i - row[j], i);
      }
    }
    previous = row;
  }
  return best;
}

/**
 * Opens with a listed model's letters, is mostly a run of a model's characters, or holds most of a long one, whatever else
 * it carries: PAPA03001AX-REFURB, LV78X for HLV78. A shop's own number that shares a few digits isn't either: N0001 beside
 * SKU00001 is still N0001.
 */
function resemblesModel(token: string, listed: string[]): boolean {
  const letters = (t: string) => /^[A-Z]*/.exec(t)?.[0] ?? "";
  const plain = normalizeModel(token);
  const t = unconfuse(plain);
  return listed.some((m) => {
    const opening = letters(normalizeModel(m));
    if (opening.length >= 2 && letters(plain) === opening) return true;
    const n = unconfuse(normalizeModel(m));
    const run = longestRun(t, n);
    // Digits after a label aren't a shared code: LOT12000 is a lot number that happens to read like 1PACU12000. A code that
    // opens with them can be: 0083X for BRZ0083. Letters are read before they're unconfused, so an L stays a letter.
    const at = t.indexOf(run);
    const sharesACode = at === 0 || /[A-Z]/.test(plain.slice(at, at + run.length));
    return run.length >= 4 && sharesACode && (run.length / t.length >= 0.6 || (n.length >= 8 && run.length / n.length >= 0.6));
  });
}

/** Opens with the letters of a listed model, whatever follows: PAPA03001AX-REFURB, PAPA-2024-SALE. */
function opensLikeModel(token: string, listed: string[]): boolean {
  const letters = (t: string) => /^[A-Z]*/.exec(t)?.[0] ?? "";
  const opening = letters(normalizeModel(token));
  return opening.length >= 2 && listed.some((m) => letters(normalizeModel(m)) === opening);
}

/** Two neighbouring words that read as one code close to a listed model: PAPA 03001AX. */
function spacedCodes(upper: string, listed: ReadonlySet<string>, close: (code: string) => boolean): string[] {
  // Split on spaces only: the hyphens in SWGR5-V2-SLV join one code, and its pieces aren't another.
  const parts = upper.slice(0, MAX_TEXT).split(/\s+/).map(normalizeModel).filter(Boolean);
  const found = new Set<string>();
  for (let i = 0; i + 1 < parts.length; i++) {
    const joined = parts[i] + parts[i + 1];
    // Beside a listed model, the other word is just a word: PAPA03001AI X and SLEEPER PAPA03001AI are that model.
    if (listed.has(parts[i]) || listed.has(parts[i + 1]) || listed.has(joined) || !MODEL_TOKEN.test(joined)) continue;
    if (close(joined)) found.add(joined);
  }
  return [...found];
}

/** The ways a shop's code can name a listed model: whole, or as a slash between models, BRZ0083/BRZ0154. */
export const codeForms = (token: string): string[] => [...new Set([normalizeModel(token), ...token.split("/").map(normalizeModel)])];

/** The recalled models a shop's text names: the same test the verdict uses, so ranking and verdict can't disagree. */
export function modelsShown(recallText: string, itemText: string): string[] {
  const upper = itemText.toUpperCase();
  const recallModels = modelTokens(recallText);
  const listed = new Set(recallModels.map(normalizeModel));
  const shownCodes = new Set(modelTokens(upper).flatMap((t) => (slashList(t, listed) ? codeForms(t) : [normalizeModel(t)])));
  return recallModels.filter((m) => shownCodes.has(normalizeModel(m)) || writtenApart(m).test(upper));
}

/** Codes in a shop's text that pass this closeness test and aren't a listed model or part of one spelled out. */
function codesBeside(recallText: string, itemText: string, close: (code: string, models: string[]) => boolean, closeSpaced: (code: string, models: string[]) => boolean): string[] {
  const upper = itemText.slice(0, MAX_TEXT).toUpperCase();
  const recallModels = modelTokens(recallText);
  const listed = new Set(recallModels.map(normalizeModel));
  // "PAPA 03001AI" is the model, so its back half isn't a second code.
  const spelledOut = new Set(modelsShown(recallText, itemText).flatMap((m) => [...upper.matchAll(new RegExp(writtenApart(m).source, "g"))].flatMap((hit) => modelTokens(hit[0]))));
  return modelTokens(upper, MAX_TEXT)
    .filter((t) => !listed.has(normalizeModel(t)) && !slashList(t, listed) && !spelledOut.has(t) && close(t, recallModels))
    .concat(spacedCodes(upper, listed, (code) => closeSpaced(code, recallModels)))
    .map((t) => t.slice(0, MAX_TOKEN));
}

/** A code about the product and not which unit it is: 2-IN-1, 0-6MONTHS, 12M. Short on purpose, so a model like 1200M isn't one. */
const FEATURE_CODE = /^(?:\d{1,2}-IN-\d{1,2}|\d{1,2}(?:-\d{1,2})?(?:M|MO|MOS|MONTHS?|Y|YR|YRS|YEARS?))$/;
const SHOP_NUMBER = /^SKU[._/-]?(.*)$/;

/** A feature, or a number the shop labels as its own, unless what follows the label holds a listed model or nearly all of one. */
function saysNothingAboutModel(token: string, listed: string[]): boolean {
  if (FEATURE_CODE.test(token)) return true;
  const number = SHOP_NUMBER.exec(token)?.[1];
  if (number === undefined) return false;
  const rest = unconfuse(normalizeModel(number));
  return !listed.some((m) => {
    const n = unconfuse(normalizeModel(m));
    return rest.includes(n) || (n.length >= 6 && longestRun(rest, n).length / n.length >= 0.8);
  });
}

/** Beside an exact model, what could make it another unit: anything like it, unless it says nothing about the model. */
const closeBesideExact = (t: string, models: string[]) => !saysNothingAboutModel(t, models) && (isSiblingModel(t, models) || isVariantOf(t, models) || opensLikeModel(t, models) || resemblesModel(t, models));

/**
 * For a check on a store listing, which has no second chance to be read: any code that could be this recall's model written
 * another way, including most of its characters in a row.
 */
export const nearMissCodes = (recallText: string, itemText: string): string[] =>
  codesBeside(recallText, itemText, closeBesideExact, (t, models) => isSiblingModel(t, models) || resemblesModel(t, models));

/** Whether the words matched say what this product is: a model, or a product word other than who it's for. */
export function namesProductLine(matched: string[]): boolean {
  return matched.some((m) => m.startsWith("model:") || (m.startsWith("product:") && m.slice("product:".length).split(",").some((w) => !WHO_ITS_FOR.has(w.trim()))));
}

/** Two or more codes joined by slashes, every one of them listed. A slash to anything else makes it another code. */
function slashList(token: string, listed: ReadonlySet<string>): boolean {
  const parts = token.split("/").map(normalizeModel);
  return parts.length > 1 && parts.every((p) => listed.has(p));
}

/**
 * What CPSC names right after the word "model", up to the end of the sentence. Wider than modelTokens: "4155L" reads like
 * litres and "1026" has no letter, and both are real models. Too wide to confirm a match on, because a bare number could
 * be anything in a shop's title. Right for a family's typed answer, where calling a recalled model "no match" is the harm.
 */
export function modelsNamedInText(text: string): string[] {
  const found = new Set<string>();
  for (const span of text.slice(0, MAX_TEXT).match(/\bmodels?\b(?:(?!\.(?:\s|$))[\s\S]){0,300}/gi) ?? []) {
    for (const token of span.match(/[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g) ?? []) {
      if (normalizeModel(token).length >= 3 && !/^(19|20)\d\d$/.test(token)) found.add(token);
    }
  }
  return [...found];
}

/** Lower-case words, with a light plural strip, so "Dryers" and "dryer" meet. */
/** Words for who a product is for. They appear across a brand's whole range, so sharing one says nothing about what it is. */
const WHO_ITS_FOR = new Set(["baby", "babie", "toddler", "infant", "newborn", "kid", "child", "children", "boy", "girl", "men", "mens", "women", "womens", "ladie", "adult", "youth", "junior", "unisex"]);

/** The words that say what a product is, leaving out who it's for. */
export const whatItIs = (text: string): string[] => [...words(text)].filter((w) => !WHO_ITS_FOR.has(w));

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

// One unit at a time: CPSC's text sends you to check this unit, or says only certain units are in. The list isn't in the
// record and a model named in it doesn't settle it, so these feed both fullScopeInRecord and limitedWithinModel.
const ONE_UNIT_AT_A_TIME: RegExp[] = [
  // Go and look it up.
  /\b(?:to see if|to determine (?:if|whether|which)|determine (?:if|whether)|to verify|to confirm|verify (?:if|whether|that)|(?:can|should|must|need to)\s+(?:also\s+)?check\b|check (?:if|whether|to see|to determine|for VINs?)|identify whether|unable to determine whether)\b/i,
  /\benter (?:their|your|the)\b[^.]{0,40}\b(?:VIN|serial|model)\b|\btype in\b|\blook-?up tool\b|\bverification tool\b|\bonline questionnaire\b|\bmust be identified through\b|\brecall links?\b/i,
  // Only the firm can say.
  /\bcontact\b[^.]{0,80}\bto (?:confirm|determine|verify|identify)\b|\bby contacting\b/i,
  // Part of a line, by an identifier CPSC doesn't list.
  /\bcertain\s+(?:models?|VINs?|vehicle identification numbers?|serial numbers?|lots?|lot codes?|date codes?|units)\b|\bqualifying serial\b/i,
];

// The ways CPSC's text says the real list isn't in it, read against all 1,855 descriptions from 2022 on. A false
// "incomplete" costs a question. A false "full" can tell a family a recalled product doesn't match, so unsure reads incomplete.
const SCOPE_ELSEWHERE: RegExp[] = [
  // A list announced, then missing.
  /listed below|included in this recall:/i,
  /:\s*$/,
  /\b[Ii]ncluded in the recall:\s+(?:The|A|An|All|Each|Consumers)\b/,
  /\bthe following\b[^.:\d]*\.\s*$/i,
  /\b(?:table|chart)\s+below\b|\bfollowing (?:table|chart)\b/i,
  /\b(?:identified|shown)\s+below\b|\bsee below\b|\b(?:numbers?|models?|codes?|ranges?)\s+below\b|\bthe below\b|\b(?:photos?|photographs?|images?|pictures?)\s+below\b/i,
  ...ONE_UNIT_AT_A_TIME,
  // The list or the details are on someone's site.
  /\bfor a (?:full |complete )?list\b|\b(?:full|complete|entire) list\b[^.]{0,100}(?:\bavailable\b|\bfound\b|\bweb ?site\b|www\.|https?:)|\blist of\b[^.]{0,80}\b(?:available|found)\b/i,
  /\b(?:numbers?|models?|codes?|units?)\b[^.]{0,80}\b(?:can be found|are|is) (?:at|on) (?:www\.|https?:|the firm|[^.]{0,30}web ?site)/i,
  /\b(?:information|photos|images|details|instructions)\b[^.]{0,80}\b(?:available|found) (?:at|on)\b[^.]{0,60}(?:www\.|https?:|web ?site)|\brecall web ?site\b/i,
  // An address beside the words for which units, in either order.
  /\b(?:models?|serials?|lots?|VINs?|numbers?|codes?|units?|lists?)\b[^.]{0,120}(?:www\.|https?:)/i,
  /(?:www\.|https?:)\S*[^.]{0,80}\b(?:models?|serials?|lots?|VINs?|numbers?|codes?|units?|lists?)\b/i,
];

/** False when CPSC's text points somewhere else for the models or lots, so the API text is not the whole scope. */
export function fullScopeInRecord(recall: Pick<Recall, "description">): boolean {
  const text = recall.description;
  if (SCOPE_ELSEWHERE.some((pointer) => pointer.test(text))) return false;
  // "Certain" of a product, with no model number anywhere to say which.
  return !(/\binvolves certain\b/i.test(text) && modelTokens(text).length === 0);
}

const IN_A_MONTH_OR_YEAR = "(?:\\d|january|february|march|april|may|june|july|august|september|october|november|december)";
const PART_OF_A_MODEL = new RegExp(
  `\\bonly\\b[^.]*\\b(?:manufactured|produced|made|dates?|date codes?|lot|serial|batch)\\b` +
    `|\\bmanufactured\\s+(?:from|between|before|after|during|prior to|on or|in\\s+${IN_A_MONTH_OR_YEAR})` +
    `|\\bmanufacture date (?:in|of|before|after|from|between)\\b` +
    `|\\b(?:one|two|three|four|five|six|several) (?:production )?(?:lots?|batch(?:es)?)\\b` +
    `|\\b(?:(?:date|lot|batch|serial)\\s*(?:code|number)s?|VINs?|serial\\s+ranges?|manufacturing\\s+dates?)\\b[^.]{0,80}\\b(?:included|recalled|affected|range|between|through)\\b`,
  "i",
);

const UNIT_ID = /\b(?:serial|lot|batch|date)\s*(?:numbers?|codes?|ranges?)\b|\bVINs?\b|\bvehicle identification numbers?\b/i;
const SAYS_WHICH = /\b(?:begin|begins|beginning|start|starts|starting|contain|contains|containing|range|ranges|ranging|within|between|through|following|one of|prefix|position|impacted)\b/i;
const SAYS_WHERE = /\b(?:located|printed|stamped|molded|engraved|imprinted|displayed|displays|appears?|under|found|listed|lists|label|labels|sticker|plate|plates|regardless|all|visible|(?:is|are)\s+(?:on|in|at|inside))\b/i;

/** The number itself, right after its name: batch number 062024, date code 2310. */
const UNIT_VALUE = /\b(?:serial|lot|batch|date)\s*(?:numbers?|codes?)\b[\s:#"]*[A-Z]*\d/i;

/** A sentence naming a serial, lot, batch, date code or VIN limits the recall, unless all it says is where that number is. */
const tiedToAUnit = (sentence: string) => UNIT_ID.test(sentence) && (SAYS_WHICH.test(sentence) || UNIT_VALUE.test(sentence) || !SAYS_WHERE.test(sentence));

/** CPSC limits the recall to part of a model: a date, a lot, a serial range, certain VINs. The model alone can't show this unit is in it. */
export const limitedWithinModel = (description: string) =>
  PART_OF_A_MODEL.test(description) || ONE_UNIT_AT_A_TIME.some((pointer) => pointer.test(description)) || description.split(/(?<=\.)\s+/).some(tiedToAUnit);

/** A sale on the recall's own calendar date needs a human: it may have been before the announcement. */
export function salePath(orderedOn: string, recallDate: string): SalePath {
  if (orderedOn < recallDate) return "NOTICE_ONLY";
  return orderedOn === recallDate ? "REVIEW" : "REFUND_ELIGIBLE";
}

export function verdictFor(
  recall: Pick<Recall, "title" | "description" | "products" | "retailers">,
  item: MatchCandidate,
  opts: { dateFilter?: boolean } = {},
): VerdictResult {
  const itemText = `${item.title} ${item.description ?? ""}`.slice(0, MAX_TEXT);
  const itemWords = words(itemText);
  const brand = brandOf(recall.title);
  const brandWords = brand ? words(brand) : new Set<string>();
  const hasBrand = brandWords.size > 0 && [...brandWords].every((w) => itemWords.has(w));
  const matched = hasBrand ? [`brand: ${brand}`] : [];
  const fullScope = fullScopeInRecord(recall);
  const seeCpsc = "the full list on CPSC's notice, which this record does not include";

  const lineWords = new Set<string>();
  for (const p of recall.products) for (const w of words(p.name)) if (!brandWords.has(w)) lineWords.add(w);
  const sharedLine = [...lineWords].filter((w) => itemWords.has(w)).sort();
  const strength: Strength = hasBrand ? "BRAND" : sharedLine.length > 0 ? "PRODUCT_WORDS" : "NO_SHARED_WORDS";
  const cleared = (reason: string, shared: string[] = []): VerdictResult => ({ verdict: "CLEARED", strength, matched: shared, missing: [], reason });

  const firstSale = firstSaleMonth(recall.retailers);
  if (opts.dateFilter !== false && item.orderedOn && firstSale && item.orderedOn.slice(0, 7) < firstSale) {
    return cleared(`Sold ${item.orderedOn}, before this product was first sold (${firstSale}).`);
  }

  // A recalled model number settles it, whatever else the text says or leaves out.
  const recallModels = modelTokens(`${recall.title} ${recall.description}`);
  const upper = itemText.toUpperCase();
  const itemCodes = modelTokens(upper);
  const shown = modelsShown(`${recall.title} ${recall.description}`, itemText);
  const nearMissCode = codesBeside(`${recall.title} ${recall.description}`, itemText, closeBesideExact, isSiblingModel);
  const limited = limitedWithinModel(recall.description);
  if (shown.length > 0 && limited) {
    return {
      verdict: "SCOPE_GAP",
      strength: "BRAND",
      matched: [...matched, `model: ${shown.join(", ")}`],
      missing: ["the unit's date, lot, serial number or VIN: CPSC recalled only part of this model"],
      reason: `The shop's text names recalled model ${shown.join(", ")}, but CPSC limits the recall by date, lot, serial number or VIN.`,
    };
  }
  if (shown.length > 0 && nearMissCode.length > 0) {
    return {
      verdict: "SCOPE_GAP",
      strength: "BRAND",
      matched: [...matched, `model: ${shown.join(", ")}`],
      missing: [`which unit this is: the shop's text also has ${nearMissCode.join(", ")}`],
      reason: `The shop's text names recalled model ${shown.join(", ")}, and also ${nearMissCode.join(", ")}, so it can't show which unit this is.`,
    };
  }
  if (shown.length > 0) {
    return {
      verdict: "MATCH",
      strength: "CONFIRMED",
      matched: [...matched, `model: ${shown.join(", ")}`],
      missing: [],
      reason: `The shop's text names recalled model ${shown.join(", ")}.`,
    };
  }

  // With the brand matched, one shared product word keeps it out of CLEARED. Without it, two do (or the
  // only word a one-word product name has). The count is the rule, so the same item gets the same answer
  // however long CPSC's product name happens to be.
  const related = hasBrand ? sharedLine.length >= 1 : sharedLine.length >= Math.min(2, lineWords.size) && sharedLine.length > 0;
  const notNamed = brand ? `, and does not name ${brand}` : "";
  const unrelatedReason = hasBrand
    ? `The same brand, but a different product from ${recall.products[0]?.name ?? "the recalled one"}.`
    : sharedLine.length === 1
      ? `Shares only "${sharedLine[0]}" with this recall${notNamed}.`
      : `Shares no product word with this recall${notNamed}.`;
  if (!related) {
    if ((hasBrand || sharedLine.length >= 1) && !fullScope) {
      return { verdict: "SCOPE_GAP", strength, matched, missing: [seeCpsc], reason: unrelatedReason };
    }
    return cleared(unrelatedReason, matched);
  }
  if (sharedLine.length > 0) matched.push(`product: ${sharedLine.join(", ")}`);

  // A code only counts as a different model when it looks like one of CPSC's and is not a variant.
  const otherModels = itemCodes.filter((t) => isSiblingModel(t, recallModels) && !isVariantOf(t, recallModels));
  const variants = itemCodes.filter((t) => isVariantOf(t, recallModels));
  if (hasBrand && otherModels.length > 0 && variants.length === 0) {
    const reason = `Model ${otherModels.join(", ")} is not one CPSC lists (${recallModels.join(", ")}).`;
    if (!fullScope) return { verdict: "SCOPE_GAP", strength, matched, missing: [seeCpsc], reason };
    return cleared(reason, matched);
  }

  // A one-model recall with a printed look: the title's own words can pin the unit, but only with the
  // brand named. A confirmed match can lead to a refund, and ordinary words in common are not enough.
  const modelParts = new Set(recallModels.flatMap((m) => [...words(m)]));
  const look = [...words(recall.description)]
    .filter((w) => !brandWords.has(w) && !lineWords.has(w) && !modelParts.has(w) && itemWords.has(w))
    .sort();
  // Any code at all stops this. A look can't tell which unit a title's code means, however unlike the model it reads.
  const carriesCode = modelTokens(upper, MAX_TEXT).some((t) => !saysNothingAboutModel(t, recallModels));
  if (hasBrand && recallModels.length === 1 && look.length >= 2 && !limited && fullScope && nearMissCode.length === 0 && !carriesCode) {
    return {
      verdict: "MATCH",
      strength: "CONFIRMED",
      matched: [...matched, `look: ${look.join(", ")}`],
      missing: [],
      reason: `A one-model recall, and the shop's text shows the look CPSC describes (${look.join(", ")}).`,
    };
  }

  const missing =
    recallModels.length > 0
      ? [`model number (CPSC lists ${[...new Set([...recallModels, ...modelsNamedInText(`${recall.title} ${recall.description}`)])].join(", ")})`]
      : ["something that shows this is the recalled version: CPSC gives no model number"];
  if (brand && !hasBrand) missing.unshift(`whether this is ${brand}`);
  if (!fullScope) missing.push(seeCpsc);
  // Sleepwear that shares only "boy" with a recall of boys' jeans is the same brand, not the same line.
  const sameKindOfThing = sharedLine.some((w) => !WHO_ITS_FOR.has(w));
  const reason = hasBrand
    ? sameKindOfThing
      ? "The same product line, but the shop's text cannot show whether this unit is covered."
      : "The same brand, but the shop's text cannot show whether this item is covered."
    : brand
      ? `The same kind of product, but the shop's text does not name ${brand}.`
      : "The same kind of product, but nothing in the shop's text ties it to this recall.";
  return { verdict: "SCOPE_GAP", strength, matched, missing, reason };
}
