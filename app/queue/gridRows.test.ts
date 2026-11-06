import { describe, expect, it } from "vitest";
import type { QueueRow } from "@/server/queue/queue";
import { toCards } from "@/server/queue/queue";
import { gridRows, inTab, TELL_CPSC_COLUMNS, unidentifiedRows } from "./gridRows";

const base: QueueRow = {
  matchId: "m1",
  recordId: "sale-1",
  recallNumber: "27040",
  recallTitle: "t",
  recallDate: "2026-10-22",
  recallUrl: "https://www.cpsc.gov/x",
  product: "Costway Convertible High Chairs",
  itemTitle: "Costway high chair",
  source: "s",
  orderedOn: "2026-09-22",
  verdict: "SCOPE_GAP",
  strength: "BRAND",
  salePath: "NOTICE_ONLY",
  joinState: "IDENTIFIED",
  matched: [],
  missing: [],
  reason: "r",
  isListing: false,
  stillListed: false,
  notice: null,
  earlierQuestionResult: null,
  question: null,
  agent: null,
  caughtSeconds: null,
  approval: null,
  refund: null,
};
const row = (over: Partial<QueueRow>): QueueRow => ({ ...base, ...over });
const build = (rows: QueueRow[]) => gridRows(rows, toCards(rows).cards);
const by = (rows: ReturnType<typeof build>, id: string) => rows.find((r) => r.matchId === id)!;

describe("which rows can be approved from the grid", () => {
  it("a sale's lead can be", () => {
    expect(by(build([row({})]), "m1").approvable).toBe(true);
  });

  it("the other recalls on a sale cannot: only the lead has Approve, and a sale gets one question", () => {
    const rows = build([row({ matchId: "lead", strength: "BRAND" }), row({ matchId: "other", recallNumber: "25206", strength: "BRAND", recallDate: "2020-01-01" })]);
    expect(by(rows, "lead").approvable).toBe(true);
    expect(by(rows, "other").approvable).toBe(false);
  });

  it.each<[string, Partial<QueueRow>]>([
    ["cleared", { verdict: "CLEARED" }],
    ["a listing, with no buyer to reach", { isListing: true }],
    ["two possible orders", { joinState: "AMBIGUOUS_JOIN" }],
    ["product words only", { strength: "PRODUCT_WORDS" }],
    ["already approved", { notice: { id: "n", kind: "CHECK_REQUEST", state: "PREPARED", stopped: false, result: null } }],
  ])("%s cannot be", (_name, over) => {
    expect(by(build([row(over)]), "m1").approvable).toBe(false);
  });
});

describe("the tabs", () => {
  const rows = build([
    row({ matchId: "lead" }),
    row({ matchId: "other", recallNumber: "25206", recallDate: "2020-01-01" }),
    row({ matchId: "clear", recordId: "sale-2", verdict: "CLEARED" }),
    row({ matchId: "shelf", recordId: "listing-1", isListing: true, stillListed: true, orderedOn: null, salePath: null, verdict: "MATCH", strength: "CONFIRMED" }),
  ]);
  const shown = (tab: Parameters<typeof inTab>[1]) => rows.filter((r) => inTab(r, tab)).map((r) => r.matchId).sort();

  it("needs review shows what the cards show", () => expect(shown("needs")).toEqual(["lead", "shelf"]));
  it("cleared shows cleared", () => expect(shown("cleared")).toEqual(["clear"]));
  it("the shelf shows matched items still listed", () => expect(shown("shelf")).toEqual(["shelf"]));
  it("the shelf shows an item once, however many recalls it comes near", () => {
    const near = build([
      row({ matchId: "lead", recordId: "listing-1", isListing: true, stillListed: true, orderedOn: null, salePath: null, verdict: "MATCH", strength: "CONFIRMED" }),
      row({ matchId: "near", recordId: "listing-1", recallNumber: "25206", isListing: true, stillListed: true, orderedOn: null, salePath: null, strength: "BRAND" }),
    ]);
    expect(near.filter((r) => inTab(r, "shelf")).map((r) => r.matchId)).toEqual(["lead"]);
  });
  it("all shows every candidate, hiding nothing", () => expect(shown("all")).toEqual(["clear", "lead", "other", "shelf"]));
});

describe("a payment it couldn't tie to an order", () => {
  const rows = unidentifiedRows([{ id: "p1", paidOn: "2026-11-05", amountCents: 4200, currency: "USD" }]);

  it("says what is known, and that it is not cleared", () => {
    expect(rows[0]).toMatchObject({ state: "Couldn't identify", itemTitle: "A PayPal payment of 42.00 USD", soldOn: "2026-11-05" });
    expect(rows[0].reason).toBe("It names no item or order, so it can't be checked against a recall. It is not cleared.");
  });

  it("has its own tab, and nothing to approve, open or tell CPSC about", () => {
    expect(inTab(rows[0], "unidentified")).toBe(true);
    for (const tab of ["needs", "cleared", "shelf", "all"] as const) expect(inTab(rows[0], tab)).toBe(false);
    expect(rows[0]).toMatchObject({ approvable: false, anchor: null, tellCpsc: false, isLead: false, listedOnShelf: false });
  });

  it("keeps a recall's rows out of that tab", () => {
    expect(inTab(by(build([row({})]), "m1"), "unidentified")).toBe(false);
  });

  it("carries no payment id to the browser", () => {
    expect(JSON.stringify(rows)).not.toContain("p1");
  });

  it("gives each row its own key, so two payments of one amount on one day stay two", () => {
    const two = unidentifiedRows([
      { id: "p1", paidOn: "2026-11-05", amountCents: 4200, currency: "USD" },
      { id: "p2", paidOn: "2026-11-05", amountCents: 4200, currency: "USD" },
    ]);
    expect(new Set(two.map((r) => r.matchId)).size).toBe(2);
  });
});

describe("what the grid holds", () => {
  it("lists sales in the order the cards do, so a seller sees one order", () => {
    const sale = (matchId: string, recallNumber: string, over: Partial<QueueRow> = {}) => row({ matchId, recallNumber, recordId: `sale-${matchId}`, ...over });
    const rows = [
      sale("gap", "27040"),
      sale("confirmed-older", "27027", { verdict: "MATCH", strength: "CONFIRMED", recallDate: "2026-10-15" }),
      sale("confirmed-newer", "27072", { verdict: "MATCH", strength: "CONFIRMED", recallDate: "2026-11-05" }),
      sale("cleared", "26059", { verdict: "CLEARED" }),
    ];
    const cards = toCards(rows).cards.map((c) => c.lead.matchId);
    expect(cards).toEqual(["confirmed-newer", "confirmed-older", "gap"]);
    expect(build(rows).map((r) => r.matchId)).toEqual([...cards, "cleared"]);
  });

  it("lists another recall on a sale after the leads, ahead of what cleared", () => {
    const rows = [row({ matchId: "clear", recordId: "sale-2", verdict: "CLEARED" }), row({ matchId: "other", recallNumber: "25206", recallDate: "2020-01-01" }), row({ matchId: "lead" })];
    expect(build(rows).map((r) => r.matchId)).toEqual(["lead", "other", "clear"]);
  });

  it("links each row to where it is on the page", () => {
    const rows = build([row({ matchId: "lead" }), row({ matchId: "clear", recordId: "sale-2", verdict: "CLEARED" })]);
    expect(by(rows, "lead").anchor).toBe("#sale-lead");
    expect(by(rows, "clear").anchor).toBeNull(); // the row already says why it cleared, and there is nothing to do
  });

  it("links another recall on a sale to that sale's window, and a recall only counted on the page to nothing", () => {
    const rows = build([row({ matchId: "lead" }), row({ matchId: "other", recallNumber: "25206", recallDate: "2020-01-01" }), row({ matchId: "unrelated", recordId: "sale-3", verdict: "CLEARED", strength: "NO_SHARED_WORDS" })]);
    expect(by(rows, "other").anchor).toBe("#sale-lead");
    expect(by(rows, "unrelated").anchor).toBeNull();
  });

  it("puts a sale on the Tell CPSC list only when it is a confirmed match sold after the recall", () => {
    const tell = (over: Partial<QueueRow>) => by(build([row(over)]), "m1").tellCpsc;
    expect(tell({ verdict: "MATCH", strength: "CONFIRMED", salePath: "REFUND_ELIGIBLE" })).toBe(true);
    expect(tell({ verdict: "MATCH", strength: "CONFIRMED", salePath: "NOTICE_ONLY" })).toBe(false);
    expect(tell({ verdict: "SCOPE_GAP", salePath: "REFUND_ELIGIBLE" })).toBe(false);
  });

  it("exports only CPSC's words and the sale date: no shop text, and nothing about a buyer", () => {
    expect(TELL_CPSC_COLUMNS).toEqual(["recallNumber", "product", "soldOn"]);
  });

  it("carries nothing a browser should not have", () => {
    const fields = Object.keys(by(build([row({})]), "m1")).sort();
    expect(fields).toEqual(["anchor", "approvable", "isLead", "itemTitle", "listedOnShelf", "matchId", "noticeState", "path", "product", "reason", "recallDate", "recallNumber", "soldOn", "state", "tellCpsc", "verdict", "weak"]);
  });
});
