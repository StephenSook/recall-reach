// What a page may say about a search result. The rules decide what is listed: only a result with the recall's brand and
// product, by title. Anything else is only counted, because naming another company's product under a recall would read as
// that product being recalled, and the brand field can hold a seller's name. Nothing here calls a listing recalled.
import type { Recall } from "../cpsc/schema";
import { verdictFor } from "../match/verdict";
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
  /** Came back, and aren't the recall's brand and product, so they aren't named. */
  notListed: number;
}

export function sweepView(recall: Pick<Recall, "title" | "description" | "products" | "retailers">, listings: MarketListing[]): SweepView {
  const same = listings.flatMap((listing) => {
    const verdict = verdictFor(recall, { title: `${listing.brand ?? ""} ${listing.title}`.trim(), description: "" });
    const sameBrand = verdict.strength === "BRAND" || verdict.strength === "CONFIRMED";
    return verdict.verdict !== "CLEARED" && sameBrand ? [{ listing, verdict }] : [];
  });
  const byTitle = new Map<string, ReviewCandidate>();
  for (const { listing, verdict } of same) {
    const key = listing.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, { id: listing.id, title: listing.title, settle: verdict.missing, namesListedModel: verdict.strength === "CONFIRMED" || verdict.matched.some((m) => m.startsWith("model:")) });
  }
  return { returned: listings.length, candidates: [...byTitle.values()], notListed: listings.length - same.length };
}
