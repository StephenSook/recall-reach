import { redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { latestReplay } from "@/server/replay/replay";
import { RunAgainButton } from "./RunAgainButton";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  busy: "Too many runs just now. Try again in a while.",
  failed: "The run could not finish. Please try again.",
};

export default async function LatestReplay({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const message = typeof error === "string" && Object.hasOwn(MESSAGES, error) ? MESSAGES[error] : null;
  const latest = message ? null : await latestReplay(getDb());
  if (latest) redirect(`/replay/${latest.runId}`);
  return (
    <main className="page">
      <header className="page-head">
        <h1>Recall Replay</h1>
      </header>
      <p>Every real CPSC recall from 2025 on, checked against the demo shop in one run.</p>
      {message ? (
        <p role="alert" className="alert">
          {message}
        </p>
      ) : null}
      <div className="actions">
        <RunAgainButton label="Run it" />
      </div>
    </main>
  );
}
