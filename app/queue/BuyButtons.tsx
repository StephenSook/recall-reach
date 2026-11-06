"use client";

import { useEffect, useState } from "react";

/**
 * The two ways a family can buy on the demo shop. Each press is a real sandbox sale, and PayPal can take a minute or two
 * to say so, so the buttons stop as soon as one is pressed and stay stopped until the card lands. The server refuses a
 * second sale too: this is only what a person sees.
 */
export function BuyButtons({ shopItemId, waiting }: { shopItemId: string; waiting: boolean }) {
  const [pressed, setPressed] = useState<"family" | "paypal" | null>(null);
  useEffect(() => {
    const reset = () => setPressed(null); // coming back with the browser's back button
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  const stopped = waiting || pressed !== null;
  return (
    <>
      <form action="/api/demo/buy" method="post" onSubmit={() => setPressed("family")}>
        <input type="hidden" name="shopItemId" value={shopItemId} />
        <button type="submit" className="btn btn-outline" disabled={stopped}>
          {pressed === "family" ? "Buying" : "Buy this as a family"}
        </button>
      </form>
      <form action="/api/demo/buy/paypal" method="post" onSubmit={() => setPressed("paypal")}>
        <input type="hidden" name="shopItemId" value={shopItemId} />
        <button type="submit" className="btn btn-outline" disabled={stopped}>
          {pressed === "paypal" ? "Opening PayPal" : "Buy with a PayPal sandbox login"}
        </button>
      </form>
      {waiting ? (
        <p className="note" data-testid="sale-on-its-way">
          That sale is on its way. PayPal can take a minute or two to tell us.
        </p>
      ) : null}
    </>
  );
}
