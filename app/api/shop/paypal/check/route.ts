import { refreshAndSay } from "@/server/shop/refreshRoute";
import { fromThisSite, refused } from "@/server/web/http";

export const dynamic = "force-dynamic";

// "Check with PayPal" on the queue: the same read as PayPal's return link.
export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  return refreshAndSay(request);
}
