// What a shop owner reads after typing one item. Nothing here reads as clear unless every recall was read and none came near.
import type { TextCheckAnswer, TextCheckResult } from "@/server/match/textCheck";

export interface RecallToRead {
  recallNumber: string;
  title: string;
  missing: string | null;
}

export interface ItemAnswer {
  kind: "MATCH" | "CANT_TELL" | "NOTHING" | "UNFINISHED";
  says: string;
  matches: RecallToRead[];
  toRead: RecallToRead[];
  further: string | null;
  gap: string | null;
}

const KIND_ONLY_SHOWN = 5;
const MISSING_LENGTH = 140;

/** A recall can list dozens of models, and this has to read on a phone. */
function clipped(text: string): string {
  if (text.length <= MISSING_LENGTH) return text;
  const cut = text.lastIndexOf(", ", MISSING_LENGTH);
  return `${text.slice(0, cut > 0 ? cut : MISSING_LENGTH)}, and more${text.endsWith(")") ? ")" : ""}`;
}

const toRow = (r: TextCheckResult): RecallToRead => ({ recallNumber: r.recallNumber, title: r.title, missing: r.missing[0] ? clipped(r.missing[0]) : null });
const further = (count: number) => (count > 0 ? `${count} more came up. Add the maker or model to narrow it.` : null);
const yearList = (years: number[]) => (years.length > 1 ? `${years.slice(0, -1).join(", ")} and ${years.at(-1)}` : String(years[0]));
const readThese = (count: number) => `Read ${count === 1 ? "this recall" : "these recalls"} and compare what you have.`;

export function readItemAnswer(answer: TextCheckAnswer): ItemAnswer {
  const matches = answer.results.filter((r) => r.verdict === "MATCH");
  const tied = answer.results.filter((r) => r.verdict !== "MATCH" && r.tiedToRecall);
  const kindOnly = answer.results.filter((r) => r.verdict !== "MATCH" && !r.tiedToRecall);
  const { recalls, from, yearsMissing } = answer.checked;
  const gap = yearsMissing.length > 0 ? `We don't hold CPSC's ${yearList(yearsMissing)} recalls right now, so there may be more.` : answer.notJudged > 0 ? "More came near than we could read. Add the maker or model." : null;
  const nothingElse = { matches: [], toRead: [], further: null, gap: null };

  if (matches.length > 0) {
    const says = matches.length === 1 ? "This matches a recall. That doesn't say this one is recalled: read it and compare the model." : `This matches ${matches.length} recalls. That doesn't say this one is recalled: read them and compare the model.`;
    return { kind: "MATCH", says, matches: matches.map(toRow), toRead: tied.map(toRow), further: further(kindOnly.length + answer.more), gap };
  }
  if (tied.length > 0) {
    return { kind: "CANT_TELL", says: `Can't tell yet. ${readThese(tied.length)}`, matches: [], toRead: tied.map(toRow), further: further(kindOnly.length + answer.more), gap };
  }
  if (kindOnly.length > 0) {
    const count = kindOnly.length + answer.more;
    const says = count === 1 ? "Can't tell yet. 1 recall covers this kind of product. Add the maker and model, or read it." : `Can't tell yet. ${count} recalls cover this kind of product. Add the maker and model, or read them.`;
    const shown = kindOnly.slice(0, KIND_ONLY_SHOWN);
    return { kind: "CANT_TELL", says, matches: [], toRead: shown.map(toRow), further: further(count - shown.length), gap };
  }
  // The rules rule out a maker typed alone, because no product word is shared. That isn't the same as no recall naming it.
  if (answer.sameMaker.length > 0) {
    const says = `Can't tell yet. The maker matches, and nothing else does. ${readThese(answer.sameMaker.length)}`;
    return { kind: "CANT_TELL", says, matches: [], toRead: answer.sameMaker.map((r) => ({ ...r, missing: null })), further: null, gap };
  }

  if (recalls === 0 || !from) return { kind: "UNFINISHED", says: "Can't say yet. No recalls are held here right now.", ...nothingElse };
  if (yearsMissing.length > 0) return { kind: "UNFINISHED", says: `Can't say yet. We don't hold CPSC's ${yearList(yearsMissing)} recalls right now.`, ...nothingElse };
  if (answer.notJudged > 0) return { kind: "UNFINISHED", says: "Can't say yet. Too many recalls came near to read them all. Add the maker or model.", ...nothingElse };
  return { kind: "NOTHING", says: `No recall in ${recalls.toLocaleString("en-US")} CPSC recalls since ${from.slice(0, 4)} names this. That doesn't mean it's safe.`, ...nothingElse };
}
