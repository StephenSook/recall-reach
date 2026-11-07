import { getDb } from "@/server/db/pg";
import { isRecallNumber } from "@/server/match/textCheck";
import { StandingRefused, turnOffStanding, turnOnStanding } from "@/server/notice/standing";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// Prepares notices for one recall without approving each. It sends nothing: each still opens in the seller's own mail.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const form = await request.formData();
  const recallNumber = String(form.get("recallNumber") ?? "");
  if (!isRecallNumber(recallNumber)) return refused(400, "not a recall number");
  try {
    if (form.get("action") === "off") await turnOffStanding(getDb(), { shopId: session.shopId, recallNumber });
    else await turnOnStanding(getDb(), { shopId: session.shopId, recallNumber, typed: String(form.get("typed") ?? "") });
    return seeOther(request, "/queue");
  } catch (err) {
    if (err instanceof StandingRefused) return withMessage(request, err.message);
    throw err;
  }
}
