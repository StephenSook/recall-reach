"use client";

import { useEffect, useState } from "react";

/** A full-size file takes a couple of minutes, so the button says so, and a second press can't start another. */
export function CheckForm() {
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const reset = () => setChecking(false); // coming back with the browser's back button
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <form className="window upload" action="/api/shop/import" method="post" encType="multipart/form-data" onSubmit={() => setChecking(true)}>
      <label className="field">
        Your shop&apos;s name
        <input name="shopName" maxLength={80} autoComplete="organization" required />
      </label>
      <label className="field">
        Your order file
        <input type="file" name="file" accept=".csv,text/csv" required />
      </label>
      <button type="submit" className="btn big" disabled={checking}>
        {checking ? "Checking your file" : "Check my file"}
      </button>
      {checking ? (
        <p className="note" role="status" data-testid="checking">
          A big file can take a couple of minutes. Please keep this page open.
        </p>
      ) : null}
    </form>
  );
}
