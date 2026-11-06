import { getDb } from "@/server/db/pg";
import { NoticeRefused, prepareNotice } from "@/server/notice/store";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

const MAX_AT_ONCE = 50;

// "Approve this notice": a person's decision that this message may go out. It sends nothing: each one still opens in the seller's own mail.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const form = await request.formData();
  const matchIds = form.getAll("matchId").map(String);
  if (matchIds.length > MAX_AT_ONCE) return withMessage(request, `Select ${MAX_AT_ONCE} or fewer at a time.`);
  let refusal: string | null = null;
  for (const matchId of matchIds) {
    try {
      await prepareNotice(getDb(), { shopId: session.shopId, matchId });
    } catch (err) {
      if (!(err instanceof NoticeRefused)) throw err;
      refusal ??= err.message;
    }
  }
  return refusal ? withMessage(request, refusal) : seeOther(request, "/queue");
}
