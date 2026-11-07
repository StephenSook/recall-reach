import { DEFECTS } from "./defects";

const REPO = "https://github.com/StephenSook/recall-reach/commit";

export default function DefectsPage() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>What went wrong</h1>
      </header>
      <p>Defects we found in our own work, what we changed, and how we checked it again.</p>
      {DEFECTS.map((d) => (
        <section key={d.title} className="window" data-testid="defect">
          <h2 className="section-title">{d.title}</h2>
          <p>
            <strong>Found:</strong> {d.found}
          </p>
          <p>
            <strong>Changed:</strong> {d.changed}{" "}
            {d.commits.map((sha, i) => (
              <span key={sha}>
                {i > 0 ? ", " : ""}
                <a href={`${REPO}/${sha}`}>{sha}</a>
              </span>
            ))}
            .
          </p>
          <p>
            <strong>Checked again:</strong> {d.checked}
          </p>
        </section>
      ))}
    </main>
  );
}
