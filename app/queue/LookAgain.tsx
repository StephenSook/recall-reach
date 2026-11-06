"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Looks again, for a while, for something that arrives by itself: a family's answer, PayPal's webhook.
 * A page left open stops asking. A tab nobody is looking at waits, and looks as soon as it's back.
 */
export function LookAgain({ everyMs, forMs }: { everyMs: number; forMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const started = Date.now();
    const look = () => {
      if (!document.hidden && Date.now() - started <= forMs) router.refresh();
    };
    const timer = setInterval(look, everyMs);
    document.addEventListener("visibilitychange", look);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", look);
    };
  }, [router, everyMs, forMs]);
  return null;
}
