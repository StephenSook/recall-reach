"use client";

import { useState } from "react";

interface ClaimResult {
  claim: string;
  kept: boolean;
  said: string;
}

/** Tries the real check on Claude's quotes, with claims planted or typed here. It calls no model. */
export function TrickCheck() {
  const [quote, setQuote] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ClaimResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (body: object) => {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/safety/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json()) as { results?: ClaimResult[]; error?: string };
      if (data.results) setResults(data.results);
      else setError(data.error ?? "The check could not run just now.");
    } catch {
      setError("The check could not run just now.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="trick-check">
      <h2 className="section-title">Try to put words in Claude&apos;s mouth</h2>
      <p>Before a finding from Claude is kept, code checks every quote against CPSC&apos;s words. Plant a claim and see it struck. It reads recall 27072. No model runs here and nothing is kept.</p>
      <div className="actions">
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void ask({})}>
          Plant two bad claims
        </button>
      </div>
      <form
        className="window upload"
        onSubmit={(event) => {
          event.preventDefault();
          void ask({ quote });
        }}
      >
        <label className="field">
          Or quote CPSC yourself <input name="quote" value={quote} maxLength={300} autoComplete="off" required onChange={(e) => setQuote(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-outline" disabled={busy}>
          Check this quote
        </button>
      </form>
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {results ? (
        <ul className="window cleared-list" data-testid="trick-results" role="status">
          {results.map((r) => (
            <li key={r.claim}>
              {r.kept ? <strong>Kept</strong> : <strong>Struck</strong>}: {r.kept ? r.claim : <s>{r.claim}</s>}
              <span className="quiet">{r.said}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
