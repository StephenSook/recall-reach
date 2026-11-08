"use client";

import { useState, type FormEvent } from "react";

/** deletesAfter is when this shop's data, and the receipt with it, is deleted, already written for a person to read. */
export function ReceiptForm({ token, shopName, demo, deletesAfter }: { token: string; shopName: string; demo: boolean; deletesAfter: string }) {
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/safety-receipts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, item: fields.get("item"), brand: fields.get("brand"), model: fields.get("model"), email: fields.get("email"), consent: fields.get("consent") === "on", website: fields.get("website") }),
      });
      const result = await response.json();
      if (!response.ok) { setError(String(result.error)); return; }
      form.reset();
      setDeletePath(result.deletePath);
    } catch {
      setError("The receipt could not be confirmed. Please ask the shop before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page" style={{ maxWidth: "36rem" }}>
      <header className="page-head"><h1>Safety receipt</h1>{demo ? <span className="chip">DEMO SHOP</span> : null}</header>
      <p>{shopName}</p>
      {deletePath ? (
        <section aria-live="polite">
          <h2>Receipt saved</h2>
          <p>Bookmark this <a href={deletePath}>delete my data</a> link. We do not email it to you. The shop can delete your receipt too.</p>
        </section>
      ) : (
        <form onSubmit={submit}>
          <p>Copy the item as written on the tag.</p>
          <label className="field" htmlFor="receipt-item">Item on the tag<input id="receipt-item" name="item" required maxLength={240} autoComplete="off" /></label>
          <label className="field" htmlFor="receipt-brand">Brand (optional)<input id="receipt-brand" name="brand" maxLength={120} autoComplete="off" /></label>
          <label className="field" htmlFor="receipt-model">Model number (optional)<input id="receipt-model" name="model" maxLength={120} autoComplete="off" /></label>
          <label className="field" htmlFor="receipt-email">Email<input id="receipt-email" name="email" type="email" required maxLength={254} autoComplete="email" /></label>
          <div hidden aria-hidden="true"><label>Leave empty<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
          <p><label><input name="consent" type="checkbox" required /> Tell me if this item is recalled.</label></p>
          {error ? <p role="alert">{error}</p> : null}
          <button className="btn" type="submit" disabled={saving}>{saving ? "Saving..." : "Save safety receipt"}</button>
          <noscript><p>Turn on JavaScript to save a receipt, or ask the shop for help.</p></noscript>
        </form>
      )}
      <details style={{ marginTop: "1.5rem" }}>
        <summary>How your data is kept</summary>
        <p>{demo
          ? `This is a demo shop. Its receipts are deleted after ${deletesAfter}, when the demo shop's data is deleted. Use a test email.`
          : `We keep this receipt until you or the shop delete it. At the latest it is deleted after ${deletesAfter}, when this shop's data is deleted.`}</p>
        <p>Your email is encrypted. Only this shop&apos;s owner sees it when preparing a notice. It is not sent to Claude, Channel3 or any other service by this app.</p>
        <p>The app never emails anyone. The owner approves a notice, opens it in their own mail and sends it.</p>
      </details>
    </main>
  );
}
