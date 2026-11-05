// The matcher's deterministic core. It reads public CPSC text and shop-owned text, and runs locally.
//
//   MATCH      the shop's text shows the recalled model, or for a one-model recall, the same line
//              with the printed look CPSC describes.
//   SCOPE_GAP  same brand and line, but the text cannot show whether this unit is covered. This is
//              the common case: CPSC's structured Model field is empty on all 934 records of 2025-26.
//   CLEARED    a different brand, product or model, or sold before the product first went on sale.
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
const MODEL_TOKEN = /(?<![\w-])(?=[A-Z0-9_./-]*\d)(?=[A-Z0-9_./-]*[A-Z])[A-Z0-9][A-Z0-9_./-]{2,}[A-Z0-9](?![\w-])/g;

/** The recalling firm, from CPSC's "<Firm> Recalls ..." title, without company words. */
export function brandOf(title: string): string | null {
  const m = /^(.+?)\s+Recalls?\s/.exec(title);
  if (!m) return null;
  const firm = m[1].split(",")[0].trim();
  const words = firm.split(/\s+/).filter((w) => !COMPANY_WORDS.has(w.toLowerCase().replace(/\.$/, "")));
  return words.length > 0 ? words.join(" ") : null;
}

export function modelTokens(text: string): string[] {
  const found = (text.match(MODEL_TOKEN) ?? []).filter((t) => !UNIT_TOKEN.test(t));
  return [...new Set(found)].sort();
}

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

  const itemText = `${item.title} ${item.description ?? ""}`;
  const itemWords = words(itemText);
  const brand = brandOf(recall.title);
  const brandWords = brand ? words(brand) : new Set<string>();
  const hasBrand = brandWords.size > 0 && [...brandWords].every((w) => itemWords.has(w));
  if (brandWords.size > 0 && !hasBrand) return cleared(`A different brand from ${brand}.`);

  const matched = hasBrand ? [`brand: ${brand}`] : [];
  const recallModels = modelTokens(`${recall.title} ${recall.description}`);
  const upper = itemText.toUpperCase();
  const shown = recallModels.filter((m) => new RegExp(`(?<![A-Z0-9])${m.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![A-Z0-9])`).test(upper));
  if (shown.length > 0) {
    return {
      verdict: "MATCH",
      matched: [...matched, `model: ${shown.join(", ")}`],
      missing: [],
      reason: `The shop's text names recalled model ${shown.join(", ")}.`,
    };
  }

  const itemModels = modelTokens(itemText);
  if (recallModels.length > 0 && itemModels.length > 0) {
    return cleared(`Model ${itemModels.join(", ")} is not one CPSC lists (${recallModels.join(", ")}).`, matched);
  }

  const lineWords = new Set<string>();
  for (const p of recall.products) for (const w of words(p.name)) if (!brandWords.has(w)) lineWords.add(w);
  const sharedLine = [...lineWords].filter((w) => itemWords.has(w)).sort();
  // With the brand matched, one shared product word keeps it out of CLEARED: a wrong clearance is the
  // worst outcome. Without a brand to lean on, most of the product's words must be there.
  const related = hasBrand ? sharedLine.length >= 1 : lineWords.size > 0 && sharedLine.length / lineWords.size >= 0.5;
  if (!related) {
    return cleared(hasBrand ? `The same brand, but a different product from ${recall.products[0]?.name ?? "the recalled one"}.` : "A different product.", matched);
  }
  matched.push(`product: ${sharedLine.join(", ")}`);

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
  return { verdict: "SCOPE_GAP", matched, missing, reason: "The same product line, but the shop's text cannot show whether this unit is covered." };
}
