import { getDb } from "@/server/db/pg";
import { loadReplay } from "@/server/replay/replay";

export const dynamic = "force-dynamic";

// A run's rows, the same ones /replay/{runId} shows: CPSC's public text and the demo shop's item titles. The saved copy
// of a run is built from this.
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await params;
  const replay = await loadReplay(getDb(), runId);
  if (!replay) return Response.json({ error: "no such run" }, { status: 404, headers: { "cache-control": "no-store" } });
  return Response.json(replay, { headers: { "cache-control": "no-store" } });
}
