"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    recallReachPushToken?: string;
  }
}

/** Only the phone app sets this token. In a browser, this does nothing. */
export function PushRegister() {
  useEffect(() => {
    const send = () => {
      const token = window.recallReachPushToken;
      if (token) fetch("/api/queue/push", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }).catch(() => {});
    };
    send();
    window.addEventListener("recall-reach-push-token", send);
    return () => window.removeEventListener("recall-reach-push-token", send);
  }, []);
  return null;
}
