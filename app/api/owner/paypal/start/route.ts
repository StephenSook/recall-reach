import { getDb } from "@/server/db/pg";
import { authorizeUrl, ownerSignInFromEnv } from "@/server/paypal/identity";
import { ownerSignInAllowed } from "@/server/owner/limit";
import { OWNER_CODES, type OwnerCode } from "@/server/owner/messages";
import { OWNER_STATE_COOKIE, OWNER_STATE_MS, startOwnerState, type OwnerIntent } from "@/server/owner/oauthState";
import { baseUrl, currentSession, fromThisSite, refused, secret, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

/** Starts Log in with PayPal: to link the signed-in shop to the owner's login, or to open the shop that login is linked to. */
export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const form = await request.formData();
  const link = form.get("intent") === "link";
  // A link starts from the queue, so its answer goes back there; a sign-in starts signed out, so its answer goes to /check.
  const back = (code: OwnerCode) => (link ? withMessage(request, OWNER_CODES[code]) : seeOther(request, `/check?error=${code}`));
  if (!ownerSignInAllowed(request.headers)) return back("OWNER_BUSY");
  const cfg = ownerSignInFromEnv(baseUrl(request));
  if (!cfg) return back("OWNER_NOT_SET_UP");
  let intent: OwnerIntent = { kind: "signin" };
  if (link) {
    const session = await currentSession();
    if (!session) return refused(401, "sign in as a shop first");
    const { rows } = await getDb().query<{ kind: string }>("select kind from shops where id = $1", [session.shopId]);
    if (rows[0]?.kind !== "REAL") return withMessage(request, "A demo shop can't be linked to a PayPal login.");
    intent = { kind: "link", shopId: session.shopId };
  }
  const { state, cookie } = startOwnerState(secret("SESSION_SECRET"), intent);
  const secure = baseUrl(request).startsWith("https:") ? "; Secure" : "";
  const response = new Response(null, { status: 303, headers: { Location: authorizeUrl(cfg, state) } });
  response.headers.append("Set-Cookie", `${OWNER_STATE_COOKIE}=${cookie}; Path=/api/owner/paypal; HttpOnly; SameSite=Lax; Max-Age=${OWNER_STATE_MS / 1000}${secure}`);
  return response;
}
