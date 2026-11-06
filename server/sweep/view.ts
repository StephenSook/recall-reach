// What a page may say about a search result. Naming another company's product under a recall would read as that product
// being recalled, and naming a seller would read as that seller selling it, so this lists very little. The brand must be the
// recall's own, exactly. The rules must read the title as the recalled product. And the title may only use the brand, CPSC's
// product name and the models CPSC lists, in plain letters, so no third party's words reach the page, and no claim about the
// product either: "recalled" and "hazard" are CPSC's words, but they aren't the product's name. Everything else is only counted.
import type { Recall } from "../cpsc/schema";
import { brandOf, modelTokens, verdictFor } from "../match/verdict";
import type { MarketListing } from "./channel3";

export interface ReviewCandidate {
  id: string;
  title: string;
  /** What it would take to settle whether this is covered. */
  settle: string[];
  /** The title names a model CPSC lists. Still only something to review. */
  namesListedModel: boolean;
}

export interface SweepView {
  returned: number;
  candidates: ReviewCandidate[];
  /** The recall's brand and product, in other words, so the title isn't printed. */
  otherWording: number;
  /** Came back without the recalling firm's exact brand, or the rules didn't read them as its product, so they aren't named. */
  notListed: number;
}

/** Anything else could look like a word on the page while reading as no word here, such as full-width letters. */
const PLAIN = /^[\x20-\x7E]+$/;
const sameName = (a: string) => a.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => w.replace(/s$/, ""));

export function sweepView(recall: Pick<Recall, "title" | "description" | "products" | "retailers">, listings: MarketListing[]): SweepView {
  const brand = brandOf(recall.title);
  const sellers = new Set(recall.retailers.flatMap(wordsOf));
  const named = `${brand ?? ""} ${recall.products.map((p) => p.name ?? "").join(" ")} ${modelTokens(`${recall.title} ${recall.description}`).join(" ")}`;
  const cpscWords = new Set(wordsOf(named).filter((w) => !sellers.has(w)));
  const same = listings.flatMap((listing) => {
    if (!brand || !listing.brand || sameName(listing.brand) !== sameName(brand)) return [];
    const verdict = verdictFor(recall, { title: `${listing.brand} ${listing.title}`, description: "" });
    return verdict.verdict === "CLEARED" ? [] : [{ listing, verdict }];
  });
  const printable = same.filter(({ listing }) => PLAIN.test(listing.title) && wordsOf(listing.title).every((w) => cpscWords.has(w)));
  const byTitle = new Map<string, ReviewCandidate>();
  for (const { listing, verdict } of printable) {
    const key = listing.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, { id: listing.id, title: listing.title, settle: verdict.missing, namesListedModel: verdict.matched.some((m) => m.startsWith("model:")) });
  }
  return { returned: listings.length, candidates: [...byTitle.values()], otherWording: same.length - printable.length, notListed: listings.length - same.length };
}
