"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import type { ReplayRow } from "@/server/replay/replay";

const ReplayGrid = dynamic(() => import("./ReplayGrid"), { ssr: false });

const WIDE = "(min-width: 768px)";
const subscribe = (change: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

export function ReplayGridLoader({ rows, licenseKey }: { rows: ReplayRow[]; licenseKey?: string | null }) {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false);
  return wide ? <ReplayGrid rows={rows} licenseKey={licenseKey} /> : null;
}
