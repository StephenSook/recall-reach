// What a page may say about a search result. Naming another company's product under a recall would read as that product
// being recalled, and naming a seller would read as that seller selling it, so this lists very little. The brand must be the
// recall's own, exactly. The rules must read the title as the recalled product. And every word of the title must already be
// in CPSC's record, so no third party's words reach the page at all. Everything else is only counted.
import type { Recall } from "../cpsc/schema";
import { brandOf, verdictFor } from "../match/verdict";
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
  /** The recall's brand and product, in words of their own, so the title isn't printed. */
  otherWording: number;
  /** Came back, and aren't the recall's brand and product, so they aren't named. */
  notListed: number;
}

const sameName = (a: string) => a.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => w.replace(/s$/, ""));

export function sweepView(recall: Pick<Recall, "title" | "description" | "products" | "retailers">, listings: MarketListing[]): SweepView {
  const brand = brandOf(recall.title);
  const sellers = new Set(recall.retailers.flatMap(wordsOf));
  const cpscWords = new Set(wordsOf(`${recall.title} ${recall.description} ${recall.products.map((p) => p.name ?? "").join(" ")}`).filter((w) => !sellers.has(w)));
  const same = listings.flatMap((listing) => {
    if (!brand || !listing.brand || sameName(listing.brand) !== sameName(brand)) return [];
    const verdict = verdictFor(recall, { title: `${listing.brand} ${listing.title}`, description: "" });
    return verdict.verdict === "CLEARED" ? [] : [{ listing, verdict }];
  });
  const printable = same.filter(({ listing }) => wordsOf(listing.title).every((w) => cpscWords.has(w)));
  const byTitle = new Map<string, ReviewCandidate>();
  for (const { listing, verdict } of printable) {
    const key = listing.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, { id: listing.id, title: listing.title, settle: verdict.missing, namesListedModel: verdict.matched.some((m) => m.startsWith("model:")) });
  }
  return { returned: listings.length, candidates: [...byTitle.values()], otherWording: same.length - printable.length, notListed: listings.length - same.length };
}
