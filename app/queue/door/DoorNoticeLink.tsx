"use client";

import { useEffect, useState } from "react";

export function DoorNoticeLink({ noticeId }: { noticeId: string }) {
  const [history, setHistory] = useState<{ printedAt: string | null } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/queue/notices/${noticeId}/door`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (res.ok) setHistory(await res.json());
        else if (res.status !== 404) setError(true);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [noticeId]);
  if (!history && !error) return null;
  return (
    <span>
      <a className="btn btn-outline" href={`/queue/door/${noticeId}`}>Print a door notice</a>
      {history?.printedAt ? <small style={{ display: "block" }}>Door notice printed {history.printedAt.slice(0, 10)}</small> : null}
      {error ? <small style={{ display: "block" }}>Print history could not be loaded.</small> : null}
    </span>
  );
}
