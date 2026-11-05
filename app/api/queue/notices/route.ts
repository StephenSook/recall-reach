import { getDb } from "@/server/db/pg";
import { NoticeRefused, prepareNotice } from "@/server/notice/store";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// "Approve this notice": a person's decision that this message may go out.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const form = await request.formData();
  try {
    await prepareNotice(getDb(), { shopId: session.shopId, matchId: String(form.get("matchId") ?? "") });
    return seeOther(request, "/queue");
  } catch (err) {
    if (err instanceof NoticeRefused) return withMessage(request, err.message);
    throw err;
  }
}
