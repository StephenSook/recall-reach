import { getDb } from "@/server/db/pg";
import { composeForSeller, NoticeRefused } from "@/server/notice/store";
import { createContactCipher } from "@/server/privacy/contactCipher";
import { baseUrl, currentSession, refused, secret } from "@/server/web/http";

export const dynamic = "force-dynamic";

// The message and address, for the signed-in shop's browser only. The browser builds the mail link,
// so the address never travels in a URL. This route logs nothing.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await currentSession();
  if (!session) return refused(401, "sign in as a shop first");
  try {
    const composed = await composeForSeller(getDb(), {
      shopId: session.shopId,
      noticeId: (await params).id,
      baseUrl: baseUrl(request),
      tokenSecret: secret("SESSION_SECRET"),
      cipher: createContactCipher(secret("SHOP_DATA_KEY"), session.shopId),
    });
    return Response.json(composed, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof NoticeRefused) return refused(err.code === "NO_SUCH_NOTICE" ? 404 : 409, err.message);
    throw err;
  }
}
