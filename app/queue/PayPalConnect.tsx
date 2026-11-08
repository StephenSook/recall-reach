import type { Connection } from "@/server/shop/paypalConnection";
import { connectPanel, type ConnectAction } from "./connectPanel";

const PATH: Record<ConnectAction, string> = { connect: "/api/shop/paypal/connect", check: "/api/shop/paypal/check", disconnect: "/api/shop/paypal/disconnect" };

function label(action: ConnectAction, started: boolean): string {
  if (action === "connect") return started ? "Connect PayPal again" : "Connect PayPal";
  return action === "check" ? "Check with PayPal" : "Disconnect";
}

/** A real shop links its own PayPal account. Every refund still waits for the owner's approval here. */
export function PayPalConnect({ connection, setUp }: { connection: Connection | null; setUp: boolean }) {
  const panel = connectPanel(connection, { setUp });
  return (
    <section className="upload" data-testid="paypal-connect" aria-labelledby="paypal-connect-title">
      <h2 id="paypal-connect-title" className="section-title">
        Refunds from your PayPal account
      </h2>
      {panel.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {panel.actions.length > 0 ? (
        <div className="actions">
          {panel.actions.map((action) => (
            <form key={action} action={PATH[action]} method="post">
              <button type="submit" className={action === "connect" && !connection ? "btn" : "btn btn-outline"}>
                {label(action, Boolean(connection))}
              </button>
            </form>
          ))}
        </div>
      ) : null}
    </section>
  );
}
