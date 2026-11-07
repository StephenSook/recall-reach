import { getDb } from "@/server/db/pg";
import { noticeIdFromToken } from "@/server/notice/token";
import { familyAnswerFrom, NoticeRefused, recordFamilyAnswer, recordFamilyPassedOn, recordFamilyStopped } from "@/server/notice/store";
import { refused, secret, seeOther } from "@/server/web/http";

export const dynamic = "force-dynamic";

// The family's page has no login: the signed link is the only key, and it opens only this notice.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const noticeId = noticeIdFromToken(secret("SESSION_SECRET"), token);
  if (!noticeId) return refused(404, "This link is not valid.");
  const form = await request.formData();
  // Back to where they tapped: the answer sits far down a phone, and a page that jumps to the top looks like nothing happened.
  const action = form.get("action");
  const place = action === "stopped" ? "#stopped" : action === "passed_on" ? "#passed-on" : "";
  try {
    if (action === "stopped") await recordFamilyStopped(getDb(), noticeId);
    else if (action === "passed_on") await recordFamilyPassedOn(getDb(), noticeId);
    else {
      const asked = form.get("asked");
      await recordFamilyAnswer(getDb(), noticeId, familyAnswerFrom(form.getAll("answer").map(String)), typeof asked === "string" ? asked : undefined);
    }
  } catch (err) {
    if (!(err instanceof NoticeRefused)) throw err;
    // The page shows the link's real state, so a refused post just lands back on it.
  }
  return seeOther(request, `/r/${token}${place}`);
}
