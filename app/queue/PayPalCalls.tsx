import type { PayPalCall } from "@/server/paypal/callLog";
import { callDocs, callThrough } from "./callLabels";

/** What the app just asked PayPal's sandbox for this shop. The call's shape only: no payloads, and ids are out of the paths. */
export function PayPalCalls({ calls }: { calls: PayPalCall[] }) {
  if (calls.length === 0) return null;
  return (
    <details data-testid="paypal-calls" className="window" style={{ marginTop: 16 }}>
      <summary>What this app asked PayPal ({calls.length})</summary>
      <p className="note">PayPal&apos;s sandbox, newest first. No payloads, and ids are out of the paths. Deleted within 48 hours.</p>
      <div className="calls-scroll" role="region" aria-label="Calls to PayPal" tabIndex={0}>
        <table className="ledger">
          <thead>
            <tr>
              <th>Call</th>
              <th>Through</th>
              <th>Answer</th>
              <th>Time</th>
              <th>PayPal-Debug-Id</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call, i) => {
              const docs = callDocs(call.template);
              const shape = `${call.method} ${call.template}`;
              return (
                <tr key={i}>
                  <td>{docs ? <a href={docs}>{shape}</a> : shape}</td>
                  <td>{callThrough(call)}</td>
                  <td>{call.status}</td>
                  <td>{call.ms} ms</td>
                  <td>{call.debugId ?? "not returned to the app"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
