import { getDb } from "@/server/db/pg";
import { proveReplay } from "@/server/replay/replay";

export const dynamic = "force-dynamic";

// Anyone can check: this recounts a run's headline numbers from its own rows, with no key.
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await params;
  const proof = await proveReplay(getDb(), runId);
  if (!proof) return Response.json({ error: "no such run" }, { status: 404, headers: { "cache-control": "no-store" } });
  return Response.json(proof, { headers: { "cache-control": "no-store" } });
}
