import { getDb } from "@/server/db/pg";
import { deleteReceipt } from "@/server/safetyReceipt/store";
import { fromThisSite, refused, seeOther } from "@/server/web/http";

export const dynamic = "force-dynamic";

/** Visiting a bookmarked link never deletes data. The family's POST is the decision. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "Please use the delete button on this site.");
  const { token } = await params;
  if (!/^[\w-]{43}$/.test(token)) return refused(404, "No such receipt link.");
  await deleteReceipt(getDb(), token);
  const response = seeOther(request, `/s/delete/${token}?done=1`);
  response.headers.set("cache-control", "no-store");
  return response;
}
