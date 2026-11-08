import type { OwnerLink } from "@/server/owner/ownerLink";
import { ownerPanel } from "./ownerPanel";

/** A real shop links its owner's PayPal login, so that login opens the shop again from any browser. */
export function OwnerSignIn({ link, setUp }: { link: OwnerLink | null; setUp: boolean }) {
  const panel = ownerPanel(link, { setUp });
  return (
    <section className="upload" data-testid="owner-signin" aria-labelledby="owner-signin-title">
      <h2 id="owner-signin-title" className="section-title">
        Sign in with PayPal next time
      </h2>
      {panel.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {panel.action === "link" ? (
        <form action="/api/owner/paypal/start" method="post" className="actions">
          <input type="hidden" name="intent" value="link" />
          <button type="submit" className="btn btn-outline">
            Link my PayPal login
          </button>
        </form>
      ) : null}
      {panel.action === "unlink" ? (
        <form action="/api/owner/paypal/unlink" method="post" className="actions">
          <button type="submit" className="btn btn-outline">
            Unlink my PayPal login
          </button>
        </form>
      ) : null}
    </section>
  );
}
