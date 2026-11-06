"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import type { WrongPair } from "./wrongPairs";

const WrongPairsGrid = dynamic(() => import("./WrongPairsGrid"), { ssr: false });

const WIDE = "(min-width: 768px)";
const subscribe = (change: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

export function WrongPairsLoader({ rows }: { rows: WrongPair[] }) {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false);
  return wide ? <WrongPairsGrid rows={rows} /> : <p className="note">On a wider screen, this is a table of all {rows.length}.</p>;
}
