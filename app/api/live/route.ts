export const dynamic = "force-dynamic";

// Liveness for the host's health checks. It deliberately touches no database, so frequent
// checks never keep Postgres awake. GET /api/health is the full, database-backed status.
export function GET(): Response {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
