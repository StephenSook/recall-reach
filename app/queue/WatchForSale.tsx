"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const EVERY_MS = 3_000;
const GIVE_UP_MS = 90_000;

/** Looks again until PayPal's webhook has put the sale in the queue. The check itself runs on the server. */
export function WatchForSale() {
  const router = useRouter();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) {
        setLate(true);
        clearInterval(timer);
        return;
      }
      router.refresh();
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <p role="status" className="alert" data-testid="watching">
      {late ? "PayPal has not told us about this sale yet. Reload this page to look again." : "A family just bought an item. Waiting for PayPal to tell us."}
    </p>
  );
}
