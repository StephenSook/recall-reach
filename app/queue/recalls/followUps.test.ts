import { describe, expect, it } from "vitest";
import { activeFollowUps, checkFollowUpDate, closingSoonLine, textChangedLine, dayLabel, followUpLines, latestDay, MOVED_NOTE, oneAtATime, placeFollowUps } from "./followUps";
import type { TimelineSale } from "./timeline";

const TODAY = "2026-11-09";
const sale = (over: Partial<TimelineSale> = {}): TimelineSale => ({ id: "m1", title: "A crib", orderedOn: "2026-11-01", windowEnds: "2027-04-30", tone: "refund", meaning: "Sold after the recall", needsReaching: true, ...over });

describe("placing follow-ups on the timeline", () => {
  it("sets the date Claude's days ask for, when the refund window has room", () => {
    expect(placeFollowUps([sale()], 5, TODAY)).toEqual({ proposals: [{ saleId: "m1", due: "2026-11-14", movedEarlier: false }], closingSoon: 0 });
  });

  it("moves it earlier when those days would run past a week before the window ends, and says it moved", () => {
    const placed = placeFollowUps([sale({ windowEnds: "2026-11-20" })], 30, TODAY);
    expect(placed.proposals).toEqual([{ saleId: "m1", due: "2026-11-13", movedEarlier: true }]);
  });

  it("can land on today, the last day a follow-up still leaves a week", () => {
    const placed = placeFollowUps([sale({ windowEnds: "2026-11-16" })], 3, TODAY);
    expect(placed).toEqual({ proposals: [{ saleId: "m1", due: TODAY, movedEarlier: true }], closingSoon: 0 });
  });

  it("offers no date when less than a week of the window is left, and counts it instead", () => {
    expect(placeFollowUps([sale({ windowEnds: "2026-11-15" })], 3, TODAY)).toEqual({ proposals: [], closingSoon: 1 });
  });

  it("doesn't tie a notice to a refund window, because a sale with no refund open has none to run out of", () => {
    const placed = placeFollowUps([sale({ tone: "notice", windowEnds: "2026-06-01" })], 7, TODAY);
    expect(placed).toEqual({ proposals: [{ saleId: "m1", due: "2026-11-16", movedEarlier: false }], closingSoon: 0 });
  });

  it("leaves out a sale that needs nobody reached, and doesn't count it", () => {
    expect(placeFollowUps([sale({ needsReaching: false })], 5, TODAY)).toEqual({ proposals: [], closingSoon: 0 });
  });

  it("places each sale on its own", () => {
    const placed = placeFollowUps([sale({ id: "a" }), sale({ id: "b", windowEnds: "2026-11-20" }), sale({ id: "c", windowEnds: "2026-11-10" })], 10, TODAY);
    expect(placed.proposals.map((p) => [p.saleId, p.due])).toEqual([["a", "2026-11-19"], ["b", "2026-11-13"]]);
    expect(placed.closingSoon).toBe(1);
  });
});

describe("checking a date the owner confirms or drags to", () => {
  const open = sale({ windowEnds: "2026-11-20" });

  it("takes today", () => {
    expect(checkFollowUpDate(open, TODAY, TODAY)).toBe("OK");
  });

  it("takes the last day that still leaves a week", () => {
    expect(checkFollowUpDate(open, "2026-11-13", TODAY)).toBe("OK");
  });

  it("refuses the day after that", () => {
    expect(checkFollowUpDate(open, "2026-11-14", TODAY)).toBe("TOO_LATE");
  });

  it("refuses a day already gone", () => {
    expect(checkFollowUpDate(open, "2026-11-08", TODAY)).toBe("PAST");
  });

  it("lets a notice's date go past the bar, with no refund window to protect", () => {
    expect(checkFollowUpDate(sale({ tone: "notice", windowEnds: "2026-06-01" }), "2026-12-09", TODAY)).toBe("OK");
  });

  it("stops a notice's date 30 days out, so it can't land off the end of the chart", () => {
    expect(checkFollowUpDate(sale({ tone: "notice", windowEnds: "2026-06-01" }), "2026-12-10", TODAY)).toBe("TOO_FAR");
  });

  it.each(["", "soon", "2026-13-40", "2026-02-30", "2026-11-14T00:00:00Z", "11/14/2026"])("refuses %j, which isn't a calendar day", (day) => {
    expect(checkFollowUpDate(open, day, TODAY)).toBe("NOT_A_DATE");
  });
});

describe("what a follow-up says", () => {
  const f = { reason: "Entrapment can injure a child quickly.", hazardQuote: "entrapment hazard", movedEarlier: false };

  it("gives the reason and CPSC's own words", () => {
    expect(followUpLines(f)).toEqual(["Entrapment can injure a child quickly.", 'CPSC: "entrapment hazard"']);
  });

  it("says when the window moved the date", () => {
    expect(followUpLines({ ...f, movedEarlier: true }).at(-1)).toBe(MOVED_NOTE);
  });

  it("writes a day the way the owner reads it, whatever the viewer's time zone", () => {
    expect(dayLabel("2026-11-20")).toBe("Nov 20");
  });

  it.each([
    [1, "1 sale: window closes too soon, refund now."],
    [2, "2 sales: window closes too soon, refund now."],
  ])("counts %i", (count, line) => {
    expect(closingSoonLine(count)).toBe(line);
  });

  it("stops the date picker a week before an open window ends", () => {
    expect(latestDay(sale({ windowEnds: "2026-11-20" }), TODAY)).toBe("2026-11-13");
  });

  it("stops it 30 days out for a sale with no refund window", () => {
    expect(latestDay(sale({ tone: "notice" }), TODAY)).toBe("2026-12-09");
  });
});

describe("which saved reminders still apply", () => {
  const saved = (matchId: string) => ({ matchId, due: "2026-11-20", reason: "r", hazardQuote: "q", movedEarlier: false });

  it("keeps a sale whose family still needs reaching", () => {
    expect(activeFollowUps([saved("m1")], [sale()])).toHaveLength(1);
  });

  it("retires one once the family has answered or a refund has started", () => {
    expect(activeFollowUps([saved("m1")], [sale({ needsReaching: false })])).toEqual([]);
  });

  it("leaves out a sale on another recall's timeline", () => {
    expect(activeFollowUps([saved("other")], [sale()])).toEqual([]);
  });
});

describe("one change at a time", () => {
  it("runs the first", async () => {
    const guard = oneAtATime();
    let ran = 0;
    expect(await guard(async () => { ran++; return "done"; })).toBe("done");
    expect(ran).toBe(1);
  });

  it("refuses a second while the first is still going, so a late answer can't undo a dismissal", async () => {
    const guard = oneAtATime();
    let finish: () => void = () => undefined;
    const first = guard(() => new Promise<string>((resolve) => { finish = () => resolve("first"); }));
    let ran = false;
    expect(await guard(async () => { ran = true; return "second"; })).toBeUndefined();
    expect(ran).toBe(false);
    finish();
    expect(await first).toBe("first");
  });

  it("lets the next one through once the first is done, even if it failed", async () => {
    const guard = oneAtATime();
    await guard(async () => { throw new Error("no"); }).catch(() => undefined);
    expect(await guard(async () => "next")).toBe("next");
  });
});

describe("sales matched before CPSC changed the recall", () => {
  it("says so for one", () => {
    expect(textChangedLine(1)).toBe("1 sale was checked against other CPSC text for this recall, so no date is proposed.");
  });

  it("says so for several", () => {
    expect(textChangedLine(3)).toBe("3 sales were checked against other CPSC text for this recall, so no date is proposed.");
  });
});

describe("the hazard's cap on how far out a date can be", () => {
  it("refuses a day past the cap even inside an open refund window", () => {
    expect(checkFollowUpDate(sale({ windowEnds: "2027-03-01" }), addDaysFor(TODAY, 15), TODAY, 14)).toBe("TOO_FAR");
  });

  it("takes the last day the cap allows", () => {
    expect(checkFollowUpDate(sale({ windowEnds: "2027-03-01" }), addDaysFor(TODAY, 14), TODAY, 14)).toBe("OK");
  });

  it("offers no later day in the date picker than the cap", () => {
    expect(latestDay(sale({ windowEnds: "2027-03-01" }), TODAY, 7)).toBe(addDaysFor(TODAY, 7));
  });

  it("still ends a week before a window that closes sooner than the cap", () => {
    expect(latestDay(sale({ windowEnds: "2026-11-20" }), TODAY, 30)).toBe("2026-11-13");
  });
});

function addDaysFor(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
