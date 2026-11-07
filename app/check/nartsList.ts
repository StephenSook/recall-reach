// NARTS' own words, from its product safety page: https://www.narts.org/product-safety-in-resale, read Nov 7, 2026.
// Shown only when these words are typed. It reports what a trade group says, and isn't a finding about the item.
const HARD_LINE: [RegExp, string][] = [
  [/\bdrop[\s-]*side\b/i, "Drop side cribs under any circumstance"],
  [/\bcribs?\b/i, "Cribs that do not meet current safety standards or are missing hardware"],
  [/\b(?:baby|infant)\s+walkers?\b/i, "Baby walkers"],
  [/\binclined?\s+sleepers?\b/i, "Inclined sleepers for babies"],
  [/\bhelmets?\b/i, "Used helmets for bikes, motorcycles, sports"],
  [/\bcedar\s+chests?\b/i, "Cedar chests with latch style locks"],
];

export const NARTS_PAGE = "https://www.narts.org/product-safety-in-resale";

/** The end of a sentence that starts "The resale trade group NARTS". */
export function nartsLine(typed: string): string | null {
  if (/\bcar[\s-]*seats?\b/i.test(typed)) return "says car seats should never be resold.";
  const item = HARD_LINE.find(([words]) => words.test(typed))?.[1];
  return item ? `lists "${item}" among items that should never be taken in resale, recalled or not.` : null;
}
