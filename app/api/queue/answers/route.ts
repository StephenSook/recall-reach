import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { recordSellerAnswer } from "@/server/match/sellerAnswers";
import { currentSession, fromThisSite, refused, seeOther } from "@/server/web/http";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256;
const BODY_TIMEOUT_MS = 5000;

// "Is this the recalled product?": it tests the matcher and changes nothing on the card.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const read = await readCappedBody(request, MAX_BODY_BYTES, { timeoutMs: BODY_TIMEOUT_MS });
  if (!read.ok) return refused(400, "not an answer");
  try {
    const form = new URLSearchParams(new TextDecoder().decode(read.body));
    const matchId = form.get("matchId") ?? "";
    if (!(await recordSellerAnswer(getDb(), { shopId: session.shopId, matchId, answer: form.get("answer") ?? "" }))) return refused(400, "not an answer");
    // recordSellerAnswer only says yes to a real id of this shop's, so it's safe in the address.
    return seeOther(request, `/queue?answered=${matchId}#sale-${matchId}`);
  } catch (err) {
    console.error("seller answer failed:", err instanceof Error ? err.name : "unknown error");
    return refused(503, "try again");
  }
}
