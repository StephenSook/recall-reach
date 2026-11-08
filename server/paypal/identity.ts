// Log in with PayPal, for a shop owner: the owner's own PayPal login, read once to learn its PayPal account id. It asks
// for nothing else (no name, no email). No PayPal token is kept. Sandbox only, through the platform app.
// Endpoints per developer.paypal.com/log-in/build, read 2026-11-08.
import { noteCall } from "./callLog";
import { PayPalApiError } from "./client";
import { PAYPAL_SANDBOX_BASE } from "./token";

export const OWNER_SCOPES = "openid https://uri.paypal.com/services/paypalattributes";
const SANDBOX_CONNECT = "https://www.sandbox.paypal.com/connect/";
const TOKEN_PATH = "/v1/oauth2/token";
const USERINFO_PATH = "/v1/identity/oauth2/userinfo";
const PAYER_ID = /^[A-Z0-9]{8,20}$/;
// An authorization code as PayPal issues it: no spaces, quotes or line breaks can ride into the form body.
const CODE = /^[A-Za-z0-9._~+/=-]{8,2048}$/;
const TIMEOUT_MS = 15_000;

export interface OwnerSignInEnv {
  clientId: string;
  clientSecret: string;
  returnUrl: string;
}

/** Null when the platform app isn't set up here, so the page says so instead of failing. */
export function ownerSignInFromEnv(baseUrl: string, env: NodeJS.ProcessEnv = process.env): OwnerSignInEnv | null {
  const clientId = env.PAYPAL_PLATFORM_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_PLATFORM_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, returnUrl: `${baseUrl}/api/owner/paypal/return` };
}

/** PayPal's own sign-in page, which sends the owner back to the return path with a code and this state. */
export function authorizeUrl(cfg: OwnerSignInEnv, state: string): string {
  const url = new URL(SANDBOX_CONNECT);
  url.searchParams.set("flowEntry", "static");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OWNER_SCOPES);
  url.searchParams.set("redirect_uri", cfg.returnUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

async function ask(fetchImpl: typeof fetch, method: "GET" | "POST", path: string, url: string, init: RequestInit): Promise<Response> {
  const at = Date.now();
  const res = await fetchImpl(url, { ...init, method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  noteCall({ method, template: path, status: res.status, ms: Date.now() - at, debugId: res.headers.get("paypal-debug-id") });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; name?: unknown };
    const issue = typeof body.error === "string" ? body.error : typeof body.name === "string" ? body.name : undefined;
    throw new PayPalApiError(res.status, method, path, issue && /^[A-Za-z0-9_]{1,80}$/.test(issue) ? issue : undefined, res.headers.get("paypal-debug-id") ?? undefined);
  }
  return res;
}

/** Swaps the code from PayPal's sign-in for the owner's PayPal account id. The token is used once and dropped. */
export async function payerIdFromCode(cfg: OwnerSignInEnv, code: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!CODE.test(code)) throw new Error("PayPal's answer had no sign-in code in PayPal's form");
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const tokenRes = await ask(fetchImpl, "POST", TOKEN_PATH, `${PAYPAL_SANDBOX_BASE}${TOKEN_PATH}`, {
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });
  const token = ((await tokenRes.json().catch(() => ({}))) as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || token.length === 0) throw new Error("PayPal's answer had no access token");
  const infoRes = await ask(fetchImpl, "GET", USERINFO_PATH, `${PAYPAL_SANDBOX_BASE}${USERINFO_PATH}?schema=paypalv1.1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const payerId = ((await infoRes.json().catch(() => ({}))) as { payer_id?: unknown }).payer_id;
  if (typeof payerId !== "string" || !PAYER_ID.test(payerId)) throw new Error("PayPal's answer had no PayPal account id in PayPal's form");
  return payerId;
}
