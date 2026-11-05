"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Composed {
  to: string | null;
  toSource: string;
  subject: string;
  body: string;
}

/** Builds the mail link here in the browser, from the signed-in shop's own session. The app never sends mail. */
export function NoticeActions({ noticeId }: { noticeId: string }) {
  const router = useRouter();
  const [composed, setComposed] = useState<Composed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/queue/notices/${noticeId}/compose`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!live) return;
        if (res.ok) setComposed(data as Composed);
        else setError(String(data.error));
      })
      .catch(() => live && setError("The message could not be loaded."));
    return () => {
      live = false;
    };
  }, [noticeId]);

  if (error) return <p role="alert">{error}</p>;
  if (!composed) return <p>Preparing the message.</p>;

  const params = `subject=${encodeURIComponent(composed.subject)}&body=${encodeURIComponent(composed.body)}`;
  const href = `mailto:${composed.to ? encodeURIComponent(composed.to) : ""}?${params}`;
  return (
    <div>
      <p>
        To: {composed.to ?? "(you add the address)"} <small>({composed.toSource})</small>
      </p>
      <p>Subject: {composed.subject}</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{composed.body}</pre>
      <a
        href={href}
        onClick={() => {
          void fetch(`/api/queue/notices/${noticeId}/opened`, { method: "POST", keepalive: true }).then(() => router.refresh());
        }}
      >
        Open in mail
      </a>
    </div>
  );
}
