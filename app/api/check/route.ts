import { getDb } from "@/server/db/pg";
import { checkText, readTextCheck } from "@/server/match/textCheck";
import { businessDay } from "@/server/time/businessDay";
import { countPublicCall } from "@/server/web/publicCalls";
import { publicCheckAllowed } from "@/server/web/publicCheck";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store", "access-control-allow-origin": "*" };

// Anyone's text against CPSC's public recalls. No key, no cookie, and nothing it is given is stored or logged.
export async function GET(request: Request): Promise<Response> {
  if (!publicCheckAllowed(request.headers)) {
    return Response.json({ error: "too many checks: try again in an hour" }, { status: 429, headers: { ...HEADERS, "retry-after": "3600" } });
  }
  const params = new URL(request.url).searchParams;
  const input = readTextCheck(params.get("title"), params.get("model"));
  if ("error" in input) return Response.json({ error: input.error }, { status: 400, headers: HEADERS });
  try {
    const db = getDb();
    const day = businessDay();
    const answer = await checkText(db, input, day);
    await countPublicCall(db, "api", day);
    return Response.json(answer, { headers: HEADERS });
  } catch (err) {
    // The name only: a database error can quote the text it was given.
    console.error("recall check failed:", err instanceof Error ? err.name : "unknown error");
    return Response.json({ error: "the check could not run just now" }, { status: 503, headers: HEADERS });
  }
}
