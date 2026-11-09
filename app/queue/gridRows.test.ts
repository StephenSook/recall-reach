import { describe, expect, it } from "vitest";
import type { QueueRow } from "@/server/queue/queue";
import { toCards } from "@/server/queue/queue";
import { gridRows, hiddenColumns, inTab, soldLabel, TELL_CPSC_COLUMNS, unidentifiedRows } from "./gridRows";

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
  agent: null, sellerAnswer: null, recallChanged: false,
  caughtSeconds: null,
  approval: null,
  refund: null,
};
const row = (over: Partial<QueueRow>): QueueRow => ({ ...base, ...over });
const build = (rows: QueueRow[]) => gridRows(rows, toCards(rows).cards);
const by = (rows: ReturnType<typeof build>, id: string) => rows.find((r) => r.matchId === id)!;

describe("which columns the grid shows", () => {
  it("hides Message while no row has one", () => expect(hiddenColumns([{ noticeState: null }, { noticeState: null }], false).has("noticeState")).toBe(true));
  it("shows Message as soon as one row has one", () => expect(hiddenColumns([{ noticeState: null }, { noticeState: "Prepared" }], false).has("noticeState")).toBe(false));
  it("hides what a store's listings have no use for, whatever else is there", () => {
    const hidden = hiddenColumns([{ noticeState: "Prepared" }], true);
    for (const field of ["path", "soldOn", "noticeState"]) expect(hidden.has(field)).toBe(true);
  });
  it("hides no sale column on an ordinary queue", () => {
    const hidden = hiddenColumns([{ noticeState: "Prepared" }], false);
    expect(hidden.has("path")).toBe(false);
    expect(hidden.has("soldOn")).toBe(false);
  });
});

describe("what the Sold column says", () => {
  it("gives the date of a sale", () => expect(soldLabel({ soldOn: "2026-09-22", listedOnShelf: false })).toBe("2026-09-22"));
  it("says an item still listed is on the shelf", () => expect(soldLabel({ soldOn: null, listedOnShelf: true })).toBe("On the shelf"));
  it("keeps a sale's date even if the item is also listed", () => expect(soldLabel({ soldOn: "2026-09-22", listedOnShelf: true })).toBe("2026-09-22"));
  it("says nothing for a row with neither", () => expect(soldLabel({ soldOn: null, listedOnShelf: false })).toBeNull());
  it("says nothing for the totals row", () => expect(soldLabel({})).toBeNull());
});

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
    ["already approved", { notice: { id: "n", kind: "CHECK_REQUEST", state: "PREPARED", stopped: false, passedOn: false, daysSinceSent: null, secondDue: false, secondPrepared: false, result: null } }],
  ])("%s cannot be", (_name, over) => {
    expect(by(build([row(over)]), "m1").approvable).toBe(false);
  });
});

describe("needs review and done", () => {
  const sent = row({ matchId: "sent", recordId: "sale-2", notice: { id: "n", kind: "CHECK_REQUEST", state: "MARKED_SENT", stopped: false, passedOn: false, daysSinceSent: null, secondDue: false, secondPrepared: false, result: null } });
  const rows = build([row({ matchId: "waiting" }), sent, row({ matchId: "other", recordId: "sale-2", recallNumber: "25206", recallDate: "2020-01-01" })]);
  const inIt = (tab: Parameters<typeof inTab>[1]) => rows.filter((r) => inTab(r, tab)).map((r) => r.matchId).sort();

  it("needs review holds only sales that still wait on the seller", () => expect(inIt("needs")).toEqual(["waiting"]));
  it("a family's no keeps a sale with other possible recalls in needs review", () => {
    const answeredNo = row({ matchId: "lead", notice: { id: "n", kind: "CHECK_REQUEST", state: "FAMILY_RESPONDED", stopped: false, passedOn: false, daysSinceSent: null, secondDue: false, secondPrepared: false, result: "DOESNT_MATCH" } });
    const near = row({ matchId: "near", recallNumber: "25206", recallDate: "2020-01-01" });
    const built = build([answeredNo, near]);
    expect(built.filter((r) => inTab(r, "needs")).map((r) => r.matchId)).toEqual(["lead"]);
  });
  it("done holds the sales that don't", () => expect(inIt("done")).toEqual(["sent"]));
  it("a sale's other recalls are in neither: its lead speaks for it", () => expect([...inIt("needs"), ...inIt("done")]).not.toContain("other"));
  it("all still shows every one", () => expect(inIt("all")).toEqual(["other", "sent", "waiting"]));
  it("a payment it couldn't tie to an order is in neither", () => {
    const payment = unidentifiedRows([{ id: "p", paidOn: null, amountCents: 100, currency: "USD" }])[0];
    expect(inTab(payment, "needs")).toBe(false);
    expect(inTab(payment, "done")).toBe(false);
  });
});

describe("what a row says", () => {
  it("follows what happened: a sent notice", () => {
    expect(by(build([row({ notice: { id: "n", kind: "CHECK_REQUEST", state: "MARKED_SENT", stopped: false, passedOn: false, daysSinceSent: null, secondDue: false, secondPrepared: false, result: null } })]), "m1").state).toBe("You marked sent");
  });

  it("follows what happened: a refund, which is no longer on offer", () => {
    const refunded = by(build([row({ verdict: "MATCH", strength: "CONFIRMED", salePath: "REFUND_ELIGIBLE", refund: { id: "r", status: "refunded", amountCents: 100, currency: "USD", failure: null } })]), "m1");
    expect(refunded.state).toBe("Refunded");
    expect(refunded.path).toBeNull();
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
  it("the shelf leaves out a listing that only shares a word with a recall, and All still shows it", () => {
    const weak = row({ matchId: "word", recordId: "listing-2", isListing: true, stillListed: true, orderedOn: null, salePath: null, verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS" });
    const [out] = gridRows([weak], [{ lead: weak, also: [] }]);
    expect(inTab(out, "shelf")).toBe(false);
    expect(inTab(out, "all")).toBe(true);
    expect(inTab(out, "needs")).toBe(true);
  });

  describe("on a real shop's queue", () => {
    const word = row({ matchId: "word", recordId: "sale-9", verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS" });
    const brand = row({ matchId: "brand", recordId: "sale-8", verdict: "SCOPE_GAP", strength: "BRAND" });
    const cleared = row({ matchId: "gone", recordId: "sale-7", verdict: "CLEARED", strength: "PRODUCT_WORDS" });
    const out = gridRows([word, brand, cleared], [{ lead: brand, also: [] }, { lead: word, also: [] }], { sharedWordsApart: true });
    const of = (id: string) => out.find((r) => r.matchId === id) as (typeof out)[number];

    it("a card that only shares a word has its own tab, and leaves Needs review and Done", () => {
      expect(inTab(of("word"), "words")).toBe(true);
      expect(inTab(of("word"), "needs")).toBe(false);
      expect(inTab(of("word"), "done")).toBe(false);
      expect(inTab(of("word"), "all")).toBe(true);
    });

    it("a word-only card with a refund in flight stays in Needs review, and doesn't move to its own tab", () => {
      const inFlight = row({ matchId: "flight", recordId: "sale-6", verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS", refund: { id: "r", status: "pending", amountCents: 100, currency: "USD", failure: null } });
      const [r] = gridRows([inFlight], [{ lead: inFlight, also: [] }], { sharedWordsApart: true });
      expect(inTab(r, "words")).toBe(false);
      expect(inTab(r, "needs")).toBe(true);
    });

    it("a brand stays in Needs review", () => {
      expect(inTab(of("brand"), "needs")).toBe(true);
      expect(inTab(of("brand"), "words")).toBe(false);
    });

    it("a cleared row stays cleared", () => {
      expect(inTab(of("gone"), "words")).toBe(false);
      expect(inTab(of("gone"), "cleared")).toBe(true);
    });
  });

  describe("on a store's listings", () => {
    const strongSoldOut = row({ matchId: "out", recordId: "l-1", isListing: true, stillListed: false, orderedOn: null, salePath: null, verdict: "SCOPE_GAP", strength: "BRAND" });
    const word = row({ matchId: "word", recordId: "l-2", isListing: true, stillListed: true, orderedOn: null, salePath: null, verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS" });
    const out = gridRows([strongSoldOut, word], [{ lead: strongSoldOut, also: [] }, { lead: word, also: [] }], { sharedWordsApart: true, listings: true });

    it("a sold-out listing that needs a check stays in Needs review. Nothing on a store's queue is done", () => {
      expect(inTab(out[0], "needs")).toBe(true);
      expect(inTab(out[0], "done")).toBe(false);
      expect(inTab(out[0], "shelf")).toBe(false);
    });

    it("one that only shares a word stays apart", () => {
      expect(inTab(out[1], "words")).toBe(true);
      expect(inTab(out[1], "needs")).toBe(false);
    });
  });

  it("a demo shop's queue has no such split: the same word-only card stays in Needs review", () => {
    const word = row({ matchId: "word", recordId: "sale-9", verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS" });
    const [out] = gridRows([word], [{ lead: word, also: [] }]);
    expect(out.apart).toBe(false);
    expect(inTab(out, "needs")).toBe(true);
    expect(inTab(out, "words")).toBe(false);
  });
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
    expect(fields).toEqual(["anchor", "apart", "approvable", "isLead", "itemTitle", "listedOnShelf", "matchId", "noticeState", "path", "product", "reason", "recallDate", "recallNumber", "refundEligible", "saleId", "saleUsd", "soldOn", "state", "tellCpsc", "verdict",
      "waits", "weak"]);
  });

  describe("the sale's price and whether it can be refunded", () => {
    const confirmed = { verdict: "MATCH", strength: "CONFIRMED", salePath: "REFUND_ELIGIBLE", joinState: "IDENTIFIED", refund: null } as const;

    it("turns the shop's own order total into dollars", () => {
      expect(by(build([row({ saleCents: 1850, saleCurrency: "USD" })]), "m1").saleUsd).toBe(18.5);
    });

    it("leaves another currency blank, so a sum never mixes them", () => {
      expect(by(build([row({ saleCents: 1850, saleCurrency: "CAD" })]), "m1").saleUsd).toBeNull();
    });

    it("reads a line discounted past its price as zero, the way the refund does", () => {
      expect(by(build([row({ saleCents: -500, saleCurrency: "USD" })]), "m1").saleUsd).toBe(0);
    });

    it("doesn't count a line with nothing to refund", () => {
      expect(by(build([row({ ...confirmed, saleCents: -500, saleCurrency: "USD" })]), "m1").refundEligible).toBe(false);
      expect(by(build([row({ ...confirmed, saleCents: 0, saleCurrency: "USD" })]), "m1").refundEligible).toBe(false);
    });

    it("leaves a listing with no sale blank", () => {
      expect(by(build([row({ saleCents: null, saleCurrency: null })]), "m1").saleUsd).toBeNull();
    });

    it("counts a confirmed sale after the recall with its payment found", () => {
      expect(by(build([row({ ...confirmed })]), "m1").refundEligible).toBe(true);
    });

    it("still counts one whose refund failed", () => {
      expect(by(build([row({ ...confirmed, refund: { id: "r", status: "failed", amountCents: 1, currency: "USD", failure: "no" } })]), "m1").refundEligible).toBe(true);
    });

    it.each([
      ["a refund already done", { refund: { id: "r", status: "refunded", amountCents: 1, currency: "USD", failure: null } }],
      ["a match nobody has confirmed", { strength: "PRODUCT_WORDS" as const }],
      ["a sale before the recall", { salePath: "NOTICE_ONLY" as const }],
      ["a sale with no payment found", { joinState: "NO_PAYPAL_RECORD" }],
    ])("doesn't count %s", (_name, over) => {
      expect(by(build([row({ ...confirmed, ...over })]), "m1").refundEligible).toBe(false);
    });
  });
});
