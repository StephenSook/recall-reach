import { getDb } from "@/server/db/pg";
import { isRecallNumber, readPublicRecall } from "@/server/match/textCheck";
import { publicCheckAllowed } from "@/server/web/publicCheck";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store", "access-control-allow-origin": "*" };

// CPSC's public record only. No key, no cookie, and no shop or buyer data.
export async function GET(request: Request, { params }: { params: Promise<{ recallNumber: string }> }): Promise<Response> {
  if (!publicCheckAllowed(request.headers)) {
    return Response.json({ error: "too many checks: try again in an hour" }, { status: 429, headers: { ...HEADERS, "retry-after": "3600" } });
  }
  const { recallNumber } = await params;
  if (!isRecallNumber(recallNumber)) return Response.json({ error: "that isn't a recall number" }, { status: 400, headers: HEADERS });
  try {
    const answer = await readPublicRecall(getDb(), recallNumber);
    if (!answer.found) return Response.json({ error: "no such recall is held here" }, { status: 404, headers: HEADERS });
    return Response.json(answer, { headers: HEADERS });
  } catch (err) {
    // The name only: a database error can quote the input it was given.
    console.error("recall read failed:", err instanceof Error ? err.name : "unknown error");
    return Response.json({ error: "the recall could not be read just now" }, { status: 503, headers: HEADERS });
  }
}
