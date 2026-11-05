import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRecalls, type Recall } from "../cpsc/schema";
import { checkQuestion, composeCheckRequest, composeSafetyNotice, type NoticeContext } from "./compose";
import { familyTokenFor, noticeIdFromToken } from "./token";

const { valid } = parseRecalls(
  JSON.parse(readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8")),
);
const recall = (n: string): Recall => valid.find((v) => v.recall.recallNumber === n)!.recall;
const raw = (n: string) => valid.find((v) => v.recall.recallNumber === n)!.raw as { Hazards: { Name: string }[]; Remedies: { Name: string }[]; URL: string };

const context = (n: string, itemTitle: string): NoticeContext => ({
  recall: recall(n),
  itemTitle,
  shopName: "DEMO SHOP",
  orderDate: "2026-09-15",
  familyUrl: "https://example.test/r/token",
});

describe("composeSafetyNotice", () => {
  const notice = composeSafetyNotice(context("27072", "Baby Brezza SuperFast Sterilizer Dryer BRZ0083"));

  it("uses the copy deck's subject, filled from the record", () => {
    expect(notice.subject).toBe("Safety recall: SuperFast Sterilizer Dryers you bought from DEMO SHOP on 2026-09-15");
  });

  it("quotes every hazard and remedy sentence verbatim from the stored CPSC record", () => {
    for (const h of raw("27072").Hazards) expect(notice.body).toContain(h.Name);
    for (const r of raw("27072").Remedies) expect(notice.body).toContain(r.Name);
  });

  it("names the recall, its CPSC link and the family page", () => {
    expect(notice.body).toContain(`CPSC recall 27072: ${raw("27072").URL}`);
    expect(notice.body).toContain("More details and steps: https://example.test/r/token");
  });

  it("says it is not the official notice and not marketing", () => {
    expect(notice.body).toContain("We're passing this along because you bought this item from us. This isn't the official recall notice, and it isn't marketing.");
  });

  it("has no refund language unless PayPal confirmed one", () => {
    expect(notice.body).not.toContain("PayPal confirmed");
    const withRefund = composeSafetyNotice({ ...context("27027", "Papablic bedside sleeper"), confirmedRefund: "90.00 USD" });
    expect(withRefund.body).toContain("PayPal confirmed a refund of 90.00 USD to your original payment. Please still follow the recall safety steps above.");
  });

  it("contains no em dash, coupon or promotion wording of our own", () => {
    const ours = notice.body.replace(raw("27072").Hazards[0].Name, "").replace(raw("27072").Remedies[0].Name, "");
    expect(ours).not.toMatch(/[—–]|coupon|% off|new arrivals|sale\b/i);
  });
});

describe("composeCheckRequest", () => {
  const question = "Does your high chair convert into a table and chair set?";
  const request = composeCheckRequest({ ...context("27040", "Costway high chair"), question });

  it("uses the copy deck's subject and asks the recall-specific question", () => {
    expect(request.subject).toBe("Quick safety check on Costway high chair you bought from DEMO SHOP");
    expect(request.body).toContain(`Can you check one thing? ${question}`);
    expect(request.body).toContain("Tap to answer: https://example.test/r/token");
  });

  it("tells them to stop using it until they can check, and links the recall", () => {
    expect(request.body).toContain(`Until you can check, stop using it and keep it out of children's reach. Read the recall details: ${raw("27040").URL}`);
  });

  it("never says the item is recalled", () => {
    expect(request.body.toLowerCase()).not.toContain("your item is recalled");
    expect(request.body).toContain("we can't tell from our records whether yours is included");
  });
});

describe("checkQuestion", () => {
  it("asks about the physical feature when CPSC gives no identifier", () => {
    expect(checkQuestion(recall("27040"))).toEqual({
      question: "Does your high chair convert into a table and chair set?",
      kind: "yes_no",
    });
  });

  it("refuses a curated question whose wording is not backed by the stored record", () => {
    const edited = { ...recall("27040"), description: "This recall involves Costway high chairs in several colors." };
    expect(checkQuestion(edited).question).not.toContain("table and chair set");
  });

  it("asks for the model number when CPSC lists models", () => {
    const q = checkQuestion(recall("27072"));
    expect(q.kind).toBe("model");
    expect(q.question).toBe("What model number is on the label? CPSC lists BRZ0083, BRZ0154, BRZ0156.");
  });
});

describe("family tokens", () => {
  const SECRET = "s".repeat(32);
  const ID = "00000000-0000-4000-8000-000000000001";

  it("round-trips, and is safe in a URL", () => {
    const t = familyTokenFor(SECRET, ID);
    expect(noticeIdFromToken(SECRET, t)).toBe(ID);
    expect(encodeURIComponent(t)).toBe(t);
  });

  it("refuses a changed id, a changed signature and another secret", () => {
    const t = familyTokenFor(SECRET, ID);
    expect(noticeIdFromToken(SECRET, t.replace(ID, "00000000-0000-4000-8000-000000000002"))).toBeNull();
    expect(noticeIdFromToken(SECRET, `${t.slice(0, -2)}xx`)).toBeNull();
    expect(noticeIdFromToken("z".repeat(32), t)).toBeNull();
    expect(noticeIdFromToken(SECRET, "garbage")).toBeNull();
  });
});
