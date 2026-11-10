// Reads the sale window and stated prices from a CPSC recall's Retailers text, for example
// "Sold Online At: Amazon.com from April 2023 through August 2026 for between $90 and $130."
// Ported from our data-exploration script (its sale_window and prices steps), which isn't in this repo; a test checks this
// port against that script's output for all 934 recalls of 2025 and 2026.

const MON = "(January|February|March|April|May|June|July|August|September|October|November|December)";
const MONTHS: Record<string, number> = Object.fromEntries(
  MON.slice(1, -1)
    .split("|")
    .map((m, i) => [m.toLowerCase(), i + 1]),
);
const DAY = "(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?";
const YEAR = "((?:19|20)\\d{2})";

// "from <Month> [day,] [of] <Year>"; month optional.
const FROM_RX = new RegExp(`\\bfrom\\s+(?:${MON}\\.?\\s+${DAY}(?:of\\s+)?)?${YEAR}\\b`, "gi");
// "from <Month> <day> through <Month> <day>, <Year>": the year appears only once, at the end.
const FROM_NOYEAR_RX = new RegExp(
  `\\bfrom\\s+${MON}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:through|to|until)\\s+${MON}?\\s*\\d{0,2},?\\s*${YEAR}`,
  "gi",
);
const THRU_RX = new RegExp(`\\b(?:through|until|thru|to)\\s+(?:${MON}\\.?\\s+${DAY}(?:of\\s+)?)?${YEAR}\\b`, "gi");
const PRICE_RX = /\$\s?([\d,]+(?:\.\d{1,2})?)/g;

export interface YearMonth {
  year: number;
  month: number;
}

export interface SaleWindow {
  /** First month the product was sold; a year-only start counts as January (the earliest it could be). */
  start: YearMonth | null;
  startMonthKnown: boolean;
  /** Last month sold; a year-only end counts as December. */
  end: YearMonth | null;
  endMonthKnown: boolean;
}

const retailText = (retailers: string[]) => retailers.join(" || ");
const ym = (month: string | undefined, year: string) => ({
  year: Number(year),
  month: month ? MONTHS[month.toLowerCase()] : null,
});

export function saleWindow(retailers: string[]): SaleWindow {
  const text = retailText(retailers);
  const starts = [...text.matchAll(FROM_RX)].map((m) => ym(m[1], m[2]));
  for (const m of text.matchAll(FROM_NOYEAR_RX)) starts.push(ym(m[1], m[3]));
  const ends = [...text.matchAll(THRU_RX)].map((m) => ym(m[1], m[2]));

  const out: SaleWindow = { start: null, startMonthKnown: false, end: null, endMonthKnown: false };
  if (starts.length > 0) {
    const key = (x: { year: number; month: number | null }) => x.year * 12 + (x.month ?? 1);
    const s = starts.reduce((a, b) => (key(b) < key(a) ? b : a));
    out.start = { year: s.year, month: s.month ?? 1 };
    out.startMonthKnown = s.month !== null;
  }
  if (ends.length > 0) {
    const key = (x: { year: number; month: number | null }) => x.year * 12 + (x.month ?? 12);
    const e = ends.reduce((a, b) => (key(b) > key(a) ? b : a));
    out.end = { year: e.year, month: e.month ?? 12 };
    out.endMonthKnown = e.month !== null;
  }
  return out;
}

/** The recall's first-sale month as YYYY-MM, or null when the text states none. */
export function firstSaleMonth(retailers: string[]): string | null {
  const { start } = saleWindow(retailers);
  return start ? `${start.year}-${String(start.month).padStart(2, "0")}` : null;
}

/** Every dollar amount stated in the Retailers text, in order. */
export function statedPrices(retailers: string[]): number[] {
  const out: number[] = [];
  for (const m of retailText(retailers).matchAll(PRICE_RX)) {
    const cleaned = m[1].replace(/,/g, "");
    if (cleaned === "" || Number.isNaN(Number(cleaned))) continue; // Python's float() rejects these too
    out.push(Number(cleaned));
  }
  return out;
}
