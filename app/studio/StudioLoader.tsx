"use client";

import dynamic from "next/dynamic";
import type { StudioRow } from "@/server/studio/dataset";

// AG Studio is large, so it loads on this page only, in its own chunk, and only in the browser.
const StudioDashboard = dynamic(() => import("./StudioDashboard").then((m) => m.StudioDashboard), {
  ssr: false,
  loading: () => <p className="note">Loading the dashboard</p>,
});

export function StudioLoader({ rows, licenseKey }: { rows: StudioRow[]; licenseKey: string | null }) {
  return <StudioDashboard rows={rows} licenseKey={licenseKey} />;
}
