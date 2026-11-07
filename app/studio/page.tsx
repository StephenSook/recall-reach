import type { Metadata } from "next";
import { getDb } from "@/server/db/pg";
import { studioDataset } from "@/server/studio/dataset";
import { StudioLoader } from "./StudioLoader";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Recall dashboard" };

async function dataset() {
  try {
    return await studioDataset(getDb());
  } catch (err) {
    console.error("studio dataset failed:", err instanceof Error ? err.name : "unknown error");
    return null;
  }
}

/** AG Studio, on Recall Replay's latest run. Its licence key is read here, at request time, and reaches only this page. */
export default async function StudioPage() {
  const data = await dataset();
  const licenseKey = process.env.AG_STUDIO_LICENSE_KEY?.trim() || null;
  return (
    <main className="page studio-page">
      <header className="page-head">
        <h1>Recall dashboard</h1>
      </header>
      <p>Ask it to change the view, in plain words.</p>
      {data ? <StudioLoader rows={data.rows} licenseKey={licenseKey} /> : <p data-testid="studio-empty">Recall Replay hasn&apos;t run yet, so there&apos;s nothing to show.</p>}
      <p className="note">CPSC&apos;s recalls from 2025 on, and what the demo shop&apos;s check found for each. Nothing PayPal returns is on this page.</p>
    </main>
  );
}
