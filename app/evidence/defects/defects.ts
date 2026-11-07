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
    checked: "During the same outage, on the deployed site: the demo shop's 9 items, Replay's 934 recalls and its recount, the public check and the MCP tool all answered from the recalls held here. Catching up once CPSC returns is still to be read.",
    open: true,
  },
  {
    title: "Sandbox refunds of $30 and up started staying PENDING",
    found:
      "From Nov 6, 2026, 17:37 UTC, PayPal's sandbox answered refunds of $30 and up with PENDING, reason ECHECK, including calls with no app code in the way. Refunds of $1, $5 and $20 completed. We don't know why.",
    changed:
      "The refund page says a pending refund isn't finished, and doesn't blame a late webhook. The demo's shelf item now costs $18. That avoids the problem and doesn't fix it, and nothing says $18 will keep working.",
    commits: ["db96fb8", "1558a0b"],
    checked: "Read Nov 6, 2026, 22:39 UTC: two $90 refunds were still pending after 5 hours. Still open.",
    open: true,
  },
];
