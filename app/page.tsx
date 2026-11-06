import { StartDemoButton } from "./StartDemoButton";

// The route sends a visitor here with a code, and only these sentences are shown.
const DEMO_MESSAGES: Record<string, string> = {
  failed: "The demo shop could not be set up. Please try again.",
  busy: "Too many demo shops from here. Try again in an hour.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ demo?: string | string[] }> }) {
  const { demo } = await searchParams;
  const message = typeof demo === "string" && Object.hasOwn(DEMO_MESSAGES, demo) ? DEMO_MESSAGES[demo] : null;
  return (
    <main>
      <h1>Help your resale shop check past sales for recalls and reach the families who bought them.</h1>
      <p>For small kids&apos; resale shops.</p>
      {message && <p role="alert">{message}</p>}
      <StartDemoButton />
      <footer>
        <p>Real CPSC recalls. Sandbox PayPal. Demo shop data is labelled.</p>
      </footer>
    </main>
  );
}
