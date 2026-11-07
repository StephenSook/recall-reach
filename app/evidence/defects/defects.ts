// Defects in our own work, with what changed and how it was checked again. Only things that happened.
export interface Defect {
  title: string;
  found: string;
  changed: string;
  /** Short hashes of the commits that changed it. */
  commits: string[];
  checked: string;
  open: boolean;
}

export const DEFECTS: Defect[] = [
  {
    title: "Check one item could say no recall named something when one did",
    found:
      "Code review of the new form, three rounds running. Bodum, sterilizer and BRZ 0083 in the label field, then plurals and a letter wrong, all read as no recall. The rules clear what they can't tie to a product, and the page turned that into a statement about every recall. A crafted link could also put words inside the answer.",
    changed:
      "It now also reads CPSC's text directly for what was typed. A miss says we didn't find a recall naming this, which is all a search can say. Nothing typed goes in that sentence.",
    commits: ["2d38e21", "3acfc16", "300f593"],
    checked: "787 cases typed from 150 recalls' own text, with plurals and a dropped letter: none read as not found. That's typing built from CPSC's words, not owners' typing, so a miss is still possible.",
    open: false,
  },
  {
    title: "A size beside an exact model stopped it confirming",
    found: "Code review found 12000-BTU beside a recalled model read as a second code, after a change of ours the same night. The first fix was too wide, and let 7928-OZ pass beside a recall listing 7927-OZ.",
    changed: "A size says nothing about which unit this is, unless this recall's own models are shaped that way.",
    commits: ["a1d2cc7", "ffff51c"],
    checked: "Sizes added beside the model in 1,374 confirmed cases from CPSC's records: none stopped confirming. 7928-OZ is a near-miss again.",
    open: false,
  },
  {
    title: "A store check read a shared brand as a reason to pull an item",
    found:
      "We ran the check on one real store's public listings. A title that only shared a word with a recall read as if it should come off the shelf, and one card said same line when the shared words only said who the product was for.",
    changed:
      "Only a confirmed match now says pull it from the shelf. A shared brand says check the shelf, cards that only share a word sit apart, and that card says same brand. The page says it can't tell whether the store sold a recalled product.",
    commits: ["ac7ad37", "e2ce270"],
    checked: "The same store on the deployed site: 238 listings, 1 needs a check, 58 share a word only. One store, so it says little about others.",
    open: false,
  },
  {
    title: "Pressing Buy twice made two sales",
    found: "PayPal's webhook can take a minute or two, so the demo's Buy button looked like it had done nothing. A second press made a second sandbox sale.",
    changed: "The buttons stop once pressed and say it can take a minute or two. The server refuses a second sale while one is on its way, including a request sent straight to it.",
    commits: ["7244f56"],
    checked: "A test on the deployed site presses Buy, finds both buttons disabled, posts straight to the server and is refused, then sees the buttons come back once the sale arrives.",
    open: false,
  },
  {
    title: "A CPSC outage read as ours, and an error row was stored as a read",
    found:
      "From about Nov 7, 2026, 00:05 UTC, CPSC's API answered HTTP 200 with one fake row, its error in the title. We stored that as a partial read, so /api/health answered 503 and those dates counted as read. The poll starts a day back, so nothing was skipped this time.",
    changed: "That row is now a failed fetch and marks nothing as read. /api/health answers 200, names CPSC and says since when, and 503 stays for this site's own failures.",
    commits: ["9d51025", "6fdda6e"],
    checked: "During the same outage, on the deployed site: the demo shop's 9 items, Replay's 934 recalls and its recount, the public check and the MCP tool all answered from the recalls held here. CPSC answered again by 01:30 UTC, and the first good read started from Nov 6, before the outage. It failed again from 02:10 UTC, and each read since has said so. Still open until a full day passes with no failed read.",
    open: true,
  },
  {
    title: "A title one character off a model could read as a confirmed match",
    found:
      "An outside review ran the real matcher on a title with a code one character from CPSC's model, plus two words from CPSC's description. It came back confirmed, and a confirmed match can lead to a notice and a refund. Found in review of the code, not by tuning on the held-out set.",
    changed: "A title carrying a code that looks like CPSC's model but isn't exactly it can't be confirmed by its look, so it asks the family instead.",
    commits: ["4827c76"],
    checked: "New tests cover codes one edit away, and codes that look nothing like a model, such as 2-IN-1. The eval, Replay and the demo queue gave the same numbers before and after.",
    open: false,
  },
  {
    title: "An uploaded sale could miss a recall the public check found",
    found: "The public check ignored punctuation in a model number, and the shop check didn't. A title with MY-002 could miss CPSC's MY002 unless similar words happened to save it.",
    changed: "Both sides now drop punctuation before comparing, in the shop check too.",
    commits: ["fe43ee0"],
    checked: "A test through the real SQL finds the recall with a hyphen or dots on either side. The eval, Replay and the demo queue gave the same numbers before and after.",
    open: false,
  },
  {
    title: "Asking PayPal again about a refund skipped the dispute check",
    found: "If a refund's first request never reached PayPal, asking again is the real first refund, and a dispute may have opened since. That path never read disputes, though a first send does.",
    changed: "Asking again now reads PayPal's disputes first, and sends nothing if there is one or the answer can't be read.",
    commits: ["de71c0a"],
    checked: "New tests with a stand-in PayPal: a dispute stops it, and so does an unreadable answer. Not yet run on the sandbox.",
    open: false,
  },
  {
    title: "Sandbox refunds started staying PENDING, first from $30, then at $18 too",
    found:
      "From Nov 6, 2026, 17:37 UTC, PayPal's sandbox answered refunds of $30 and up with PENDING, reason ECHECK, including calls with no app code in the way. Refunds of $1, $5 and $20 completed. We didn't know why then.",
    changed:
      "The refund page says a pending refund isn't finished, and doesn't blame a late webhook. The site now runs on a second sandbox business account whose PayPal balance is funded, with its own app and webhook. The demo's shelf item still costs $18.",
    commits: ["db96fb8", "1558a0b"],
    checked:
      "On the old account, read Nov 6, 22:39 UTC and Nov 7, 13:28 UTC: refunds of $90, $90 of a $500 sale and $18 all stayed pending, reason ECHECK, while its balance report read $55,956.00, and a $24.00 payout came back INSUFFICIENT_FUNDS. That points to an empty real balance. On the funded account, Nov 7, 20:02 UTC: an $18 sale and its full refund came back COMPLETED, and still COMPLETED 65 seconds later. After the switch, on the deployed site, Nov 7, about 23:23 UTC: a demo shop's $18 sale reached the queue in 16 seconds through the new webhook, its $18 refund read COMPLETED, PayPal's refund webhook was verified, and Replay read the same counts as before. Refunds made on the old account stay pending there.",
    open: false,
  },
];
