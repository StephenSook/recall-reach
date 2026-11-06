import { seedDemoShop } from "@/server/demo/seed";
import { getDb } from "@/server/db/pg";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { businessDay } from "@/server/time/businessDay";
import { fromThisSite, refused, secret, seeOther, signIn } from "@/server/web/http";
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
    const { shopId } = await seedDemoShop(getDb(), payPalClientFromEnv(), {
      today: businessDay(),
      secret: secret("SHOP_DATA_KEY"),
      demoEmail: process.env.DEMO_BUYER_EMAIL || undefined,
    });
    return signIn(request, seeOther(request, "/queue"), shopId);
  } catch (err) {
    console.error("demo start failed:", err instanceof Error ? err.message : "unknown error");
    return seeOther(request, "/?demo=failed");
  }
}
