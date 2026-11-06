"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import type { GridRow } from "./gridRows";

const MatchGrid = dynamic(() => import("./MatchGrid"), { ssr: false });

const WIDE = "(min-width: 768px)";
const subscribe = (change: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** A table this wide does not fit a phone, and a phone has the windows, so it never downloads the grid. */
export function MatchGridLoader({ rows }: { rows: GridRow[] }) {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false);
  return wide ? <MatchGrid rows={rows} /> : null;
}
