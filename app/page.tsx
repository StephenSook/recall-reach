import Link from "next/link";
import { StartDemoButton } from "./StartDemoButton";

// The route sends a visitor here with a code, and only these sentences are shown.
const DEMO_MESSAGES: Record<string, string> = {
  failed: "The demo shop could not be set up. Please try again.",
  busy: "Too many demo shops from here. Try again in an hour.",
  deleted: "Your shop's data was deleted.",
  noqueue: "Start a demo shop to see its queue.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ demo?: string | string[] }> }) {
  const { demo } = await searchParams;
  const message = typeof demo === "string" && Object.hasOwn(DEMO_MESSAGES, demo) ? DEMO_MESSAGES[demo] : null;
  return (
    <main className="door">
      <div className="door-card">
        <h1>Help your resale shop check past sales for recalls and reach the families who bought them.</h1>
        <p className="lead">For small kids&apos; resale shops.</p>
        {message && (
          <p role="alert" className="alert">
            {message}
          </p>
        )}
        <StartDemoButton />
        <p className="door-no-login">No login.</p>
        <p className="door-other">
          <Link className="btn btn-outline big" href="/check">
            Check your own order file
          </Link>
        </p>
        <footer>
          <p>Real CPSC recalls. Sandbox PayPal. Demo shop data is labelled.</p>
          <p>
            <Link href="/judge">Judging this? Start here</Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
