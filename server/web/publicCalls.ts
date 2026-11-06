import type { Queryable } from "../db/types";

export type PublicSurface = "api" | "mcp";

/** Adds one to today's count. A count that fails never costs the caller their answer. */
export async function countPublicCall(db: Queryable, surface: PublicSurface, day: string): Promise<void> {
  try {
    await db.query(
      "insert into public_calls (day, surface, calls) values ($1::date, $2, 1) on conflict (day, surface) do update set calls = public_calls.calls + 1",
      [day, surface],
    );
  } catch (err) {
    console.error("public call count failed:", err instanceof Error ? err.name : "unknown error");
  }
}

export async function publicCallTotals(db: Queryable): Promise<Record<PublicSurface, number> & { since: string | null }> {
  const { rows } = await db.query<{ surface: PublicSurface; calls: string; since: string }>(
    "select surface, sum(calls)::text as calls, min(day)::text as since from public_calls group by surface",
  );
  const count = (surface: PublicSurface) => Number(rows.find((r) => r.surface === surface)?.calls ?? 0);
  return { api: count("api"), mcp: count("mcp"), since: rows.map((r) => r.since).sort()[0] ?? null };
}
