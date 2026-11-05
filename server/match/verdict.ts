// The matcher's deterministic core. It reads public CPSC text and shop-owned text, and runs locally.
//
//   MATCH      the shop's text shows the recalled model, or for a one-model recall, the same line
//              with the printed look CPSC describes.
//   SCOPE_GAP  same brand and line, but the text cannot show whether this unit is covered. This is
//              the common case: CPSC's structured Model field is empty on all 934 records of 2025-26.
//   CLEARED    a different product, a sibling model CPSC did not list, or sold before first sale.
//
// A wrong CLEARED is the worst outcome here, so anything uncertain lands in SCOPE_GAP.
import type { Recall } from "../cpsc/schema";
import { firstSaleMonth } from "../cpsc/retailText";

export type Verdict = "MATCH" | "SCOPE_GAP" | "CLEARED";
export type SalePath = "NOTICE_ONLY" | "REVIEW" | "REFUND_ELIGIBLE";

export interface VerdictResult {
  verdict: Verdict;
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
const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:V|W|MAH|OZ|FT|IN|MM|CM|ML|L|GB|TB|HZ|LB|LBS|PCS|PC|PK|X|D|K|AH|A|QT|CC|HP|G)$/;
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
  return words.length > 0 ? words.join(" ") : null;
}

export function modelTokens(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.slice(0, MAX_TEXT).split(/[^A-Za-z0-9_./-]+/)) {
    const token = raw.replace(/[._/-]+$/, "");
    if (token.length <= MAX_TOKEN && MODEL_TOKEN.test(token) && !UNIT_TOKEN.test(token)) found.add(token);
  }
  return [...found].sort();
}

/** Same letters up front and about the same length, so a code like X200 does not count as a sibling. */
function isSiblingModel(token: string, listed: string[]): boolean {
  const prefix = (t: string) => /^[A-Z]*/.exec(t)?.[0] ?? "";
  return listed.some((m) => prefix(m) !== "" && prefix(m) === prefix(token) && Math.abs(m.length - token.length) <= 2);
}

const isVariantOf = (token: string, listed: string[]) => listed.some((m) => token.includes(m) || m.includes(token));

/** Lower-case words, with a light plural strip, so "Dryers" and "dryer" meet. */
function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** False when CPSC says the models or lots are listed elsewhere, so the API text is not the whole scope. */
export function fullScopeInRecord(recall: Pick<Recall, "description">): boolean {
  return !/listed below|included in this recall:/i.test(recall.description);
}

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
  const cleared = (reason: string, matched: string[] = []): VerdictResult => ({ verdict: "CLEARED", matched, missing: [], reason });

  const firstSale = firstSaleMonth(recall.retailers);
  if (opts.dateFilter !== false && item.orderedOn && firstSale && item.orderedOn.slice(0, 7) < firstSale) {
    return cleared(`Sold ${item.orderedOn}, before this product was first sold (${firstSale}).`);
  }

  const itemText = `${item.title} ${item.description ?? ""}`.slice(0, MAX_TEXT);
  const itemWords = words(itemText);
  const brand = brandOf(recall.title);
  const brandWords = brand ? words(brand) : new Set<string>();
  const hasBrand = brandWords.size > 0 && [...brandWords].every((w) => itemWords.has(w));
  const matched = hasBrand ? [`brand: ${brand}`] : [];
  const fullScope = fullScopeInRecord(recall);
  const seeCpsc = "the full list on CPSC's notice, which this record does not include";

  // A recalled model number settles it, whatever else the text says or leaves out.
  const recallModels = modelTokens(`${recall.title} ${recall.description}`);
  const upper = itemText.toUpperCase();
  const shown = recallModels.filter((m) => new RegExp(`(?<![A-Z0-9])${m.replace(/[.*+?^\${}()|[\]\\/]/g, "\\$&")}(?![A-Z0-9])`).test(upper));
  if (shown.length > 0) {
    return {
      verdict: "MATCH",
      matched: [...matched, `model: ${shown.join(", ")}`],
      missing: [],
      reason: `The shop's text names recalled model ${shown.join(", ")}.`,
    };
  }

  const lineWords = new Set<string>();
  for (const p of recall.products) for (const w of words(p.name)) if (!brandWords.has(w)) lineWords.add(w);
  const sharedLine = [...lineWords].filter((w) => itemWords.has(w)).sort();
  const lineShare = lineWords.size > 0 ? sharedLine.length / lineWords.size : 0;

  // With the brand matched, one shared product word keeps it out of CLEARED: a wrong clearance is the
  // worst outcome. A title that merely omits the brand needs most of the product's words. There is no
  // vendor field to tell an absent brand from another brand, so that stays a gap for a person.
  const related = hasBrand ? sharedLine.length >= 1 : sharedLine.length >= 2 && lineShare >= 0.5;
  const unrelatedReason = hasBrand
    ? `The same brand, but a different product from ${recall.products[0]?.name ?? "the recalled one"}.`
    : brand
      ? `A different product, and it does not name ${brand}.`
      : "A different product.";
  if (!related) {
    if (hasBrand && !fullScope) {
      return { verdict: "SCOPE_GAP", matched, missing: [seeCpsc], reason: unrelatedReason };
    }
    return cleared(unrelatedReason, matched);
  }
  if (sharedLine.length > 0) matched.push(`product: ${sharedLine.join(", ")}`);

  // A code only counts as a different model when it looks like one of CPSC's and is not a variant.
  const otherModels = modelTokens(itemText).filter((t) => isSiblingModel(t, recallModels) && !isVariantOf(t, recallModels));
  const variants = modelTokens(itemText).filter((t) => isVariantOf(t, recallModels));
  if (hasBrand && otherModels.length > 0 && variants.length === 0) {
    const reason = `Model ${otherModels.join(", ")} is not one CPSC lists (${recallModels.join(", ")}).`;
    if (!fullScope) return { verdict: "SCOPE_GAP", matched, missing: [seeCpsc], reason };
    return cleared(reason, matched);
  }

  // A one-model recall with a printed look: the title's own words can pin the unit.
  const look = [...words(recall.description)]
    .filter((w) => !brandWords.has(w) && !lineWords.has(w) && itemWords.has(w))
    .sort();
  if (recallModels.length === 1 && look.length >= 2) {
    return {
      verdict: "MATCH",
      matched: [...matched, `look: ${look.join(", ")}`],
      missing: [],
      reason: `A one-model recall, and the shop's text shows the look CPSC describes (${look.join(", ")}).`,
    };
  }

  const missing =
    recallModels.length > 0
      ? [`model number (CPSC lists ${recallModels.join(", ")})`]
      : ["something that shows this is the recalled version: CPSC gives no model number"];
  if (brand && !hasBrand) missing.unshift(`whether this is ${brand}`);
  if (!fullScope) missing.push(seeCpsc);
  return { verdict: "SCOPE_GAP", matched, missing, reason: "The same product line, but the shop's text cannot show whether this unit is covered." };
}
