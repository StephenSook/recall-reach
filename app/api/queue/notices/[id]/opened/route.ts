import { getDb } from "@/server/db/pg";
import { markOpened, NoticeRefused } from "@/server/notice/store";
import { currentSession, fromThisSite, refused } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  try {
    await markOpened(getDb(), { shopId: session.shopId, noticeId: (await params).id });
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof NoticeRefused) return refused(404, err.message);
    throw err;
  }
}
