import { getDb } from "@/server/db/pg";
import { proveReplay } from "@/server/replay/replay";

export const dynamic = "force-dynamic";

// Anyone can check: this recounts a run's headline numbers from its own rows, with no key.
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await params;
  const proof = await proveReplay(getDb(), runId);
  if (!proof) return Response.json({ error: "no such run" }, { status: 404, headers: { "cache-control": "no-store" } });
  // Whoever opens this reads it as it is, so whether the numbers agree comes first, on its own line.
  const { agree, sameRecalls, ...rest } = proof;
  const readable = JSON.stringify({ agree, sameRecalls, ...rest }, null, 2);
  return new Response(readable, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
