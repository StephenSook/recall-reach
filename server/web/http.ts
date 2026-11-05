import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE, type ShopSession } from "../session/session";

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

/** A form on another site must not act for a signed-in shop. Same-site cookies do most of this already. */
export function fromThisSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === baseUrl(request);
}

export const seeOther = (request: Request, path: string) =>
  new Response(null, { status: 303, headers: { Location: `${baseUrl(request)}${path}` } });

export const withMessage = (request: Request, message: string) => seeOther(request, `/queue?message=${encodeURIComponent(message)}`);

export const refused = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
