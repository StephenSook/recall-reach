export default function Home() {
  return (
    <main>
      <h1>Help your resale shop check past sales for recalls and reach the families who bought them.</h1>
      <p>For small kids&apos; resale shops.</p>
      <form action="/api/demo/start" method="post">
        <button type="submit">Try it as a demo shop</button>
      </form>
      <footer>
        <p>Real CPSC recalls. Sandbox PayPal. Demo shop data is labelled.</p>
      </footer>
    </main>
  );
}
