import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE, SESSION_MS, sessionCookie, type ShopSession } from "../session/session";
import { messageQuery } from "./queueMessage";

export function secret(name: "SESSION_SECRET" | "SHOP_DATA_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

/** Where this app is reached from outside. Render provides it; behind a proxy the request URL is internal. */
export function baseUrl(request?: Request): string {
  const external = process.env.RENDER_EXTERNAL_URL;
  if (external) return external.replace(/\/$/, "");
  if (!request) return "http://localhost:3000";
  return new URL(request.url).origin;
}

export async function currentSession(): Promise<ShopSession | null> {
  const jar = await cookies();
  return readSession(secret("SESSION_SECRET"), jar.get(SESSION_COOKIE)?.value);
}

/** Signs a shop in on this response. The one place a session cookie is built, so its Max-Age and its signed expiry agree and it stays Secure on https. */
export function signIn(request: Request, response: Response, shopId: string, lastsMs: number = SESSION_MS): Response {
  const { value } = sessionCookie(secret("SESSION_SECRET"), shopId, new Date(), lastsMs);
  const secure = baseUrl(request).startsWith("https:") ? "; Secure" : "";
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lastsMs / 1000}${secure}`);
  return response;
}

/**
 * A state-changing POST must come from a page on this site. Browsers send Origin on every form POST, and a
 * sandboxed frame sends "null", so no Origin and "null" are both refused. Demo start needs this most: it
 * has no session to check, and each call makes real sandbox captures.
 */
export function fromThisSite(request: Request): boolean {
  return request.headers.get("origin") === baseUrl(request);
}

export const seeOther = (request: Request, path: string) =>
  new Response(null, { status: 303, headers: { Location: `${baseUrl(request)}${path}` } });

export const withMessage = (request: Request, message: string) => seeOther(request, `/queue?${messageQuery(secret("SESSION_SECRET"), message)}`);

export const refused = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
