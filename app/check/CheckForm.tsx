"use client";

import { useEffect, useState } from "react";

function useChecking() {
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const reset = () => setChecking(false); // coming back with the browser's back button
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return [checking, setChecking] as const;
}

/** One item, typed at the counter. A plain form: on a slow phone it works before the page's scripts have loaded. */
export function ItemForm({ title, model, maxTitle, maxModel }: { title: string; model: string; maxTitle: number; maxModel: number }) {
  const [checking, setChecking] = useChecking();
  return (
    <form className="window upload" action="/check" method="get" data-testid="item-form" onSubmit={() => setChecking(true)}>
      <label className="field">
        What&apos;s on the label
        <input name="title" defaultValue={title} maxLength={maxTitle} autoComplete="off" enterKeyHint="search" />
      </label>
      <label className="field">
        Model number, if you can see it
        <input name="model" defaultValue={model} maxLength={maxModel} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="search" />
      </label>
      <button type="submit" className="btn big" disabled={checking}>
        {checking ? "Checking" : "Check it"}
      </button>
    </form>
  );
}

/** A full-size file takes a couple of minutes, so the button says so, and a second press can't start another. */
export function CheckForm() {
  const [checking, setChecking] = useChecking();
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

/** A store's public listings. The same wait, plus the pause between pages this owes the store. */
export function StoreForm() {
  const [checking, setChecking] = useChecking();
  return (
    <form className="window upload" action="/api/shop/listings" method="post" data-testid="store-form" onSubmit={() => setChecking(true)}>
      <label className="field">
        Type your store&apos;s web address
        <input name="address" maxLength={300} inputMode="url" autoCapitalize="none" autoCorrect="off" autoComplete="url" spellCheck={false} placeholder="yourstore.com" required />
      </label>
      <button type="submit" className="btn big btn-outline" disabled={checking}>
        {checking ? "Reading your listings" : "Check my listings"}
      </button>
      {checking ? (
        <p className="note" role="status" data-testid="reading">
          A big store can take a couple of minutes. Please keep this page open.
        </p>
      ) : null}
    </form>
  );
}
