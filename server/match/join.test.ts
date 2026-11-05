import { describe, expect, it } from "vitest";
import { joinOrderLines, PAYPAL_HISTORY_MONTHS, type JoinLine, type JoinPayment } from "./join";

const TODAY = "2026-11-05";
const line = (id: string, over: Partial<JoinLine> = {}): JoinLine => ({
  id,
  orderNumber: `#${id}`,
  title: `Title ${id}`,
  sku: null,
  orderedOn: "2026-10-01",
  ...over,
});
const payment = (key: string, over: Partial<JoinPayment> = {}): JoinPayment => ({
  key,
  orderNumber: null,
  items: [],
  ...over,
});
const run = (lines: JoinLine[], payments: JoinPayment[], failedMonths?: string[]) =>
  joinOrderLines(lines, payments, { today: TODAY, failedMonths });

describe("joinOrderLines", () => {
  it("identifies a line by the shop's order number on the payment", () => {
    const r = run([line("a")], [payment("P1", { orderNumber: "#a" })]);
    expect(r.lines.a).toEqual({ state: "IDENTIFIED", paymentKey: "P1", linkedBy: "order number" });
    expect(r.unidentifiedPayments).toBe(0);
  });

  it("links every line of a multi-line order to its one payment", () => {
    const r = run([line("a", { orderNumber: "#o" }), line("b", { orderNumber: "#o" })], [payment("P1", { orderNumber: "#o" })]);
    expect(r.lines.a.state).toBe("IDENTIFIED");
    expect(r.lines.b.state).toBe("IDENTIFIED");
  });

  it("identifies a line by SKU when the payment has no order number and only one line claims it", () => {
    const r = run([line("a", { sku: "S1" })], [payment("P1", { items: [{ name: "x", sku: "S1" }] })]);
    expect(r.lines.a).toEqual({ state: "IDENTIFIED", paymentKey: "P1", linkedBy: "SKU" });
  });

  it("identifies a line by exact title when there is no SKU", () => {
    const r = run([line("a", { title: "Red Stroller" })], [payment("P1", { items: [{ name: "Red Stroller", sku: null }] })]);
    expect(r.lines.a).toEqual({ state: "IDENTIFIED", paymentKey: "P1", linkedBy: "exact title" });
  });

  it("is ambiguous when two lines reuse the SKU one payment carries", () => {
    const r = run(
      [line("a", { sku: "S1", title: "Swing" }), line("b", { sku: "S1", title: "Swing" })],
      [payment("P1", { items: [{ name: "Swing", sku: "S1" }] })],
    );
    expect(r.lines.a).toEqual({ state: "AMBIGUOUS_JOIN", paymentKey: null, linkedBy: null });
    expect(r.lines.b.state).toBe("AMBIGUOUS_JOIN");
  });

  it("is ambiguous when one line could be either of two payments", () => {
    const r = run(
      [line("a", { sku: "S1" })],
      [payment("P1", { items: [{ name: "x", sku: "S1" }] }), payment("P2", { items: [{ name: "x", sku: "S1" }] })],
    );
    expect(r.lines.a.state).toBe("AMBIGUOUS_JOIN");
  });

  it("is ambiguous when two payments carry the same order number", () => {
    const r = run([line("a")], [payment("P1", { orderNumber: "#a" }), payment("P2", { orderNumber: "#a" })]);
    expect(r.lines.a.state).toBe("AMBIGUOUS_JOIN");
  });

  it("counts a payment with no items and no link as unidentified", () => {
    const r = run([line("a")], [payment("P1", { orderNumber: "#a" }), payment("BARE")]);
    expect(r.unidentifiedPayments).toBe(1);
  });

  it("counts a payment with items that no line claims as unidentified", () => {
    expect(run([], [payment("P1", { items: [{ name: "x", sku: "S9" }] })]).unidentifiedPayments).toBe(1);
  });

  it("says history is unavailable for a line older than PayPal's three years", () => {
    expect(PAYPAL_HISTORY_MONTHS).toBe(36);
    const r = run([line("old", { orderedOn: "2023-10-31" })], []);
    expect(r.lines.old).toEqual({ state: "HISTORY_UNAVAILABLE", paymentKey: null, linkedBy: null });
  });

  it("says history is unavailable when the search window for that month failed", () => {
    const r = run([line("a", { orderedOn: "2026-06-15" })], [], ["2026-06"]);
    expect(r.lines.a.state).toBe("HISTORY_UNAVAILABLE");
  });

  it("marks a recent line with no PayPal record as not paid through PayPal, which is not a clearance", () => {
    const r = run([line("a")], []);
    expect(r.lines.a).toEqual({ state: "NO_PAYPAL_RECORD", paymentKey: null, linkedBy: null });
  });

  it("an order number link wins over a failed window: the payment is in hand", () => {
    const r = run([line("a", { orderedOn: "2026-06-15" })], [payment("P1", { orderNumber: "#a" })], ["2026-06"]);
    expect(r.lines.a.state).toBe("IDENTIFIED");
  });
});
