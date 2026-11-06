"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import type { Timeline } from "./timeline";

const RefundTimeline = dynamic(() => import("./RefundTimeline"), { ssr: false });

const WIDE = "(min-width: 768px)";
const subscribe = (change: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** A timeline needs width. On a phone the list below it says the same in words. */
export function RefundTimelineLoader({ timeline }: { timeline: Timeline }) {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false);
  return wide ? <RefundTimeline timeline={timeline} /> : null;
}
