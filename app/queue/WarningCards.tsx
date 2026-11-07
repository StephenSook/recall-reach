import { WARNINGS_PAGE, type ShopWarning } from "@/server/warnings/warnings";

export function warningMailto(w: ShopWarning): string {
  const body = [`The U.S. Consumer Product Safety Commission has warned about ${w.product} (warning ${w.number}).`, "", "The hazard, in CPSC's words:", w.hazard, "", "What to do, in CPSC's words:", w.consumerAction, "", `CPSC's warnings: ${WARNINGS_PAGE}`].join("\n");
  return `mailto:?subject=${encodeURIComponent("A CPSC safety warning about something you bought from us")}&body=${encodeURIComponent(body)}`;
}

/** Apart from the recall cards, with their own label and count. A warning has no remedy, so there is no refund here. */
export function WarningCards({ warnings, demo }: { warnings: ShopWarning[]; demo: boolean }) {
  if (warnings.length === 0) return null;
  return (
    <details data-testid="cpsc-warnings" className="window" style={{ marginTop: 16 }}>
      <summary>CPSC warnings ({warnings.length})</summary>
      <p className="note">When a company can&apos;t be found or won&apos;t cooperate, CPSC warns instead of recalling. There&apos;s no remedy from the company, so there&apos;s nothing to refund here. These aren&apos;t in any recall count.</p>
      {warnings.map((w) => (
        <section key={`${w.number}:${w.itemTitle}`} data-testid="cpsc-warning">
          <p>
            <span className="chip">CPSC WARNING</span> {w.number}, {w.warnedOn}
          </p>
          <h3>{w.product}</h3>
          <p>
            {demo ? "A labelled sample title, not a sale" : "Your title"}: {w.itemTitle}
          </p>
          <p>
            <strong>The hazard, in CPSC&apos;s words:</strong> {w.hazard}
          </p>
          <p>
            <strong>What to do, in CPSC&apos;s words:</strong> {w.consumerAction}
          </p>
          <p>
            <a href={warningMailto(w)}>Open a notice in your mail</a>. You add the address and send it. <a href={WARNINGS_PAGE}>CPSC&apos;s warnings</a>.
          </p>
        </section>
      ))}
    </details>
  );
}
