import { cookies } from "next/headers";
import { getDb } from "@/server/db/pg";
import { callsBelongTo, withCallLog } from "@/server/paypal/callLog";
import { PayPalApiError } from "@/server/paypal/client";
import { ownerSignInFromEnv, payerIdFromCode } from "@/server/paypal/identity";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { LINKED, OWNER_CODES, type OwnerCode } from "@/server/owner/messages";
import { ownerReturnAllowed } from "@/server/owner/limit";
import { consumeOwnerState, OWNER_STATE_COOKIE, readOwnerState } from "@/server/owner/oauthState";
import { linkOwner, markOwnerSignedIn, shopForOwner } from "@/server/owner/ownerLink";
import { shopDeletesAfter } from "@/server/safetyReceipt/store";
import { baseUrl, currentSession, refused, secret, seeOther, signIn, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 86_400_000;

/**
 * PayPal sends the owner back here with a code and the state this site gave it. The code is used only when the state
 * matches this browser's signed cookie, which is then cleared, so each sign-in is used once. A link also needs the same
 * shop session that started it. A sign-in opens the linked shop in a new session, never one the browser brought.
 */
export async function GET(request: Request): Promise<Response> {
  if (!ownerReturnAllowed(request.headers)) return seeOther(request, "/check?error=OWNER_BUSY");
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const intent = readOwnerState(secret("SESSION_SECRET"), (await cookies()).get(OWNER_STATE_COOKIE)?.value, state);
  const secure = baseUrl(request).startsWith("https:") ? "; Secure" : "";
  const clear = (response: Response) => {
    response.headers.append("Set-Cookie", `${OWNER_STATE_COOKIE}=; Path=/api/owner/paypal; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    return response;
  };
  const back = (code: OwnerCode) => clear(intent?.kind === "link" ? withMessage(request, OWNER_CODES[code]) : seeOther(request, `/check?error=${code}`));
  if (!intent) return back("OWNER_EXPIRED");
  const db = getDb();
  if (!(await consumeOwnerState(db, state))) return back("OWNER_EXPIRED");
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code) return back("OWNER_CANCELLED");
  const cfg = ownerSignInFromEnv(baseUrl(request));
  if (!cfg) return back("OWNER_NOT_SET_UP");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) throw new Error("RECORD_HMAC_SECRET is not set");
  const now = new Date();

  if (intent.kind === "link") {
    const session = await currentSession();
    if (!session || session.shopId !== intent.shopId) return clear(refused(401, "sign in as that shop first"));
    let payerId: string;
    try {
      payerId = await withCallLog(db, intent.shopId, () => payerIdFromCode(cfg, code));
    } catch (err) {
      console.warn("owner PayPal link not confirmed:", err instanceof PayPalApiError ? err.message : "no PayPal account id");
      return back("OWNER_FAILED");
    }
    return clear(withMessage(request, LINKED[await linkOwner(db, { shopId: intent.shopId, payerId, recordKey, now })]));
  }

  let shopId: string | null;
  try {
    shopId = await withCallLog(db, null, async () => {
      const found = await shopForOwner(db, { payerId: await payerIdFromCode(cfg, code), recordKey });
      if (found) callsBelongTo(found);
      return found;
    });
  } catch (err) {
    console.warn("owner PayPal sign-in not confirmed:", err instanceof PayPalApiError ? err.message : "no PayPal account id");
    return back("OWNER_FAILED");
  }
  if (!shopId) return back("OWNER_NOT_LINKED");
  // The session lasts no longer than the shop itself: it ends when the shop's data is deleted, at most a week from now.
  const deletesAfter = await shopDeletesAfter(db, shopId);
  const lastsMs = deletesAfter ? Math.min(deletesAfter.getTime() - now.getTime(), WEEK_MS) : 0;
  if (lastsMs < 60_000) return back("OWNER_SHOP_GONE");
  await markOwnerSignedIn(db, shopId, now);
  return clear(signIn(request, withMessage(request, "Signed in with PayPal."), shopId, Math.floor(lastsMs / 1000) * 1000));
}
