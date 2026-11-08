import { refreshAndSay } from "@/server/shop/refreshRoute";

export const dynamic = "force-dynamic";

// PayPal sends the seller back here after sign-up. Only a read: PayPal's status, then, if connected, the shop's sales.
export async function GET(request: Request): Promise<Response> {
  return refreshAndSay(request);
}
