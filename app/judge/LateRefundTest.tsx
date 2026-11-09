"use client";

import { useState } from "react";
import type { JudgeRefusalResult } from "@/server/paypal/judgeRefusal";
import { REFUND_STATE } from "../queue/labels";

export function LateRefundResult({ result }: { result: JudgeRefusalResult }) {
  return (
    <div role="status">
      <p>{result.message}</p>
      {result.status !== null ? <p>PayPal HTTP status: {result.status}</p> : null}
      {result.details.filter((detail) => detail.issue || detail.description).map((detail, i) => (
        <p key={i}><code>{detail.issue}</code>{detail.description ? <>: {detail.description}</> : null}</p>
      ))}
      {result.expected ? <p>What the owner sees: {REFUND_STATE.failed} ({result.details[0].issue})</p> : null}
    </div>
  );
}

export function LateRefundTest() {
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<JudgeRefusalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function ask() {
    setAsking(true);
    setResult(null);
    setError(null);
    try {
      const response = await fetch("/api/judge/late-refund", { method: "POST" });
      const body = await response.json();
      if (response.ok) setResult(body as JudgeRefusalResult);
      else setError(body.error ?? "This test could not run just now.");
    } catch {
      setError("The test did not answer. No PayPal result is available.");
    } finally {
      setAsking(false);
    }
  }
  return (
    <section className="window" data-testid="late-refund-test" aria-labelledby="late-refund-title">
      <h2 id="late-refund-title" className="section-title">Sandbox test: PayPal refuses a late refund</h2>
      <p>We ask PayPal&apos;s sandbox to answer as if this sale&apos;s refund window had passed, on a sale already refunded, so no money can move.</p>
      <button type="button" className="btn" disabled={asking} onClick={ask}>{asking ? "Asking PayPal" : "See PayPal refuse a late refund"}</button>
      {result ? <LateRefundResult result={result} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
