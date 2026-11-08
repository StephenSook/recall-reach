import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { readDoorNotice, recordDoorPrint } from "@/server/notice/door";
import { NoticeRefused } from "@/server/notice/store";
import { currentSession, fromThisSite, refused } from "@/server/web/http";
import { createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";
const prints = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const session = await currentSession();
  if (!session) return refused(401, "sign in as a shop first");
  try {
    const notice = await readDoorNotice(getDb(), { shopId: session.shopId, noticeId: (await params).id });
    return Response.json({ printedAt: notice.printedAt }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof NoticeRefused) return refused(404, err.message);
    throw err;
  }
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  if (!prints(session.shopId)) return refused(429, "Too many print actions. Try again in a while.");
  const capped = await readCappedBody(request, 1024, { timeoutMs: 5_000 });
  if (!capped.ok) return refused(413, "The print action is too large or took too long to read.");
  let actionId: unknown;
  let version: unknown;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(capped.body));
    actionId = body && typeof body === "object" && "actionId" in body ? body.actionId : null;
    version = body && typeof body === "object" && "version" in body ? body.version : null;
  } catch {
    return refused(400, "A print action needs a valid action id.");
  }
  if (typeof actionId !== "string" || typeof version !== "string") return refused(400, "A print action needs a valid action id.");
  try {
    const printedAt = await recordDoorPrint(getDb(), { ...session, noticeId: (await params).id, actionId, version });
    return Response.json({ printedAt }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof NoticeRefused) return refused(err.code === "NO_SUCH_NOTICE" ? 404 : 400, err.message);
    throw err;
  }
}
