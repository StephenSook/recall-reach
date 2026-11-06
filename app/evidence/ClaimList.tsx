import type { Claim } from "./claims";

/** One line per claim: what it does and the file a reader can open to see it. */
export function ClaimList({ claims }: { claims: Claim[] }) {
  return (
    <ul className="window cleared-list" data-testid="claims">
      {claims.map((c) => (
        <li key={`${c.file}:${c.find}`}>
          <strong>{c.what}</strong>
          <span className="quiet id">{c.file}</span>
        </li>
      ))}
    </ul>
  );
}
