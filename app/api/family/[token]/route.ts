import { getDb } from "@/server/db/pg";
import { noticeIdFromToken } from "@/server/notice/token";
import { recordFamilyAnswer, recordFamilyStopped } from "@/server/notice/store";
import { refused, secret, seeOther } from "@/server/web/http";

export const dynamic = "force-dynamic";

// The family's page has no login: the signed link is the only key, and it opens only this notice.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const noticeId = noticeIdFromToken(secret("SESSION_SECRET"), token);
  if (!noticeId) return refused(404, "This link is not valid.");
  const form = await request.formData();
  if (form.get("action") === "stopped") await recordFamilyStopped(getDb(), noticeId);
  else await recordFamilyAnswer(getDb(), noticeId, String(form.get("answer") ?? "").slice(0, 80));
  return seeOther(request, `/r/${token}`);
}
