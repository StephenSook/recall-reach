// What a shop owner reads after typing one item. Nothing here reads as clear unless every recall was read and none has what was typed.
import type { TextCheckAnswer, TextCheckResult } from "@/server/match/textCheck";

export interface RecallToRead {
  recallNumber: string;
  title: string;
  missing: string | null;
}

export interface ItemAnswer {
  kind: "MATCH" | "CANT_TELL" | "NOT_NAMED" | "NOTHING" | "UNFINISHED";
  says: string;
  /** Beside "we didn't find": the recalls that only share a kind of product. */
  sameKind: string | null;
  matches: RecallToRead[];
  toRead: RecallToRead[];
  /** Recalls that only share a kind of product, for the owner to open if their label says one of these makers. */
  folded: RecallToRead[];
  further: string | null;
  gap: string | null;
}

const SHARED_SHOWN = 5;
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
  const nothingElse = { sameKind: null, matches: [], toRead: [], folded: [], further: null, gap: null };

  if (matches.length > 0) {
    const says = matches.length === 1 ? "This matches a recall. That doesn't say this one is recalled: read it and compare the model." : `This matches ${matches.length} recalls. That doesn't say this one is recalled: read them and compare the model.`;
    return { kind: "MATCH", says, sameKind: null, matches: matches.map(toRow), toRead: tied.map(toRow), folded: [], further: further(kindOnly.length + answer.more), gap };
  }
  if (tied.length > 0) {
    return { kind: "CANT_TELL", says: `Can't tell yet. ${readThese(tied.length)}`, sameKind: null, matches: [], toRead: tied.map(toRow), folded: [], further: further(kindOnly.length + answer.more), gap };
  }
  // Past what the rules tied: the recalls that could be this, then the ones that only share a kind of product. With a year
  // missing or some unread, "no recall names it" can't be said, so they all count as could-be.
  const couldBe = gap ? kindOnly : kindOnly.filter((r) => r.sharesWords || r.strength === "BRAND");
  const sameKindRows = gap ? [] : kindOnly.filter((r) => !couldBe.includes(r));
  const shared = [...couldBe.map(toRow), ...answer.mentioned.recalls.map((r) => ({ ...r, missing: null }))];
  if (shared.length > 0) {
    const count = kindOnly.length + answer.more + answer.mentioned.total;
    const says = count === 1 ? "Can't tell yet. 1 recall shares words with this. Read it and compare what you have." : `Can't tell yet. ${count} recalls share words with this. Read them and compare what you have.`;
    const shown = shared.slice(0, SHARED_SHOWN);
    return { kind: "CANT_TELL", says, sameKind: null, matches: [], toRead: shown, folded: [], further: further(count - shown.length), gap };
  }
  // A search reports what it found. A miss here is a search that didn't find something, and the sentence says that, no more.
  // Nothing typed goes in it: a link can carry any text, and it mustn't be able to write the answer.
  const notFound = `We didn't find a recall naming this in ${recalls.toLocaleString("en-US")} CPSC recalls since ${(from ?? "").slice(0, 4)}. That doesn't mean it's safe.`;
  if (sameKindRows.length > 0) {
    const count = sameKindRows.length + answer.more;
    const line = count === 1 ? "1 recall of the same kind doesn't name it. If your label says its maker, read that recall." : `${count} recalls of the same kind don't name it. If your label says one of their makers, read that recall.`;
    return { kind: "NOT_NAMED", says: notFound, sameKind: line, matches: [], toRead: [], folded: sameKindRows.map((r) => ({ recallNumber: r.recallNumber, title: r.title, missing: null })), further: null, gap: null };
  }

  if (recalls === 0 || !from) return { kind: "UNFINISHED", says: "Can't say yet. No recalls are held here right now.", ...nothingElse };
  if (yearsMissing.length > 0) return { kind: "UNFINISHED", says: `Can't say yet. We don't hold CPSC's ${yearList(yearsMissing)} recalls right now.`, ...nothingElse };
  if (answer.notJudged > 0) return { kind: "UNFINISHED", says: "Can't say yet. Too many recalls came near to read them all. Add the maker or model.", ...nothingElse };
  return { kind: "NOTHING", says: notFound, ...nothingElse };
}
