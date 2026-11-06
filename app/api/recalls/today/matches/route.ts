import { getDb } from "@/server/db/pg";
import { latestRecallDay } from "@/server/replay/replay";

export const dynamic = "force-dynamic";

// The newest day of recalls against the demo shop, from the latest Recall Replay. No key, and nothing from PayPal.
export async function GET(request: Request): Promise<Response> {
  const shop = new URL(request.url).searchParams.get("shop");
  if (shop !== "demo") return Response.json({ error: 'only shop=demo is public' }, { status: 400 });
  const day = await latestRecallDay(getDb());
  if (!day) return Response.json({ error: "no Recall Replay has run yet: press Run it on /replay" }, { status: 404 });
  return Response.json({ shop, ...day }, { headers: { "cache-control": "no-store" } });
}
