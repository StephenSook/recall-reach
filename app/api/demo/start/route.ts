import { seedDemoShop } from "@/server/demo/seed";
import { getDb } from "@/server/db/pg";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { sessionCookie, SESSION_COOKIE } from "@/server/session/session";
import { baseUrl, fromThisSite, refused, secret, seeOther } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

// Each demo shop makes real sandbox captures, so it is limited per visitor and for everyone together.
const perVisitor = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
const everyone = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor) || !everyone("all")) return seeOther(request, "/?demo=busy");
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { shopId } = await seedDemoShop(getDb(), payPalClientFromEnv(), {
      today,
      secret: secret("SHOP_DATA_KEY"),
      demoEmail: process.env.DEMO_BUYER_EMAIL || undefined,
    });
    const { value } = sessionCookie(secret("SESSION_SECRET"), shopId);
    const response = seeOther(request, "/queue");
    const secure = baseUrl(request).startsWith("https:") ? "; Secure" : "";
    response.headers.append("Set-Cookie", `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`);
    return response;
  } catch (err) {
    console.error("demo start failed:", err instanceof Error ? err.message : "unknown error");
    return seeOther(request, "/?demo=failed");
  }
}
