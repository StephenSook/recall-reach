import { getDb } from "@/server/db/pg";
import { NoticeRefused, prepareSecondNotice } from "@/server/notice/store";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  try {
    await prepareSecondNotice(getDb(), { shopId: session.shopId, noticeId: (await params).id });
    return seeOther(request, "/queue");
  } catch (err) {
    if (err instanceof NoticeRefused) return withMessage(request, err.message);
    throw err;
  }
}
