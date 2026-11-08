import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { receiptAllowed } from "@/server/safetyReceipt/limit";
import { createReceipt, receiptShop, ReceiptRefused } from "@/server/safetyReceipt/store";
import { fromThisSite, refused, secret } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "Please use the form on this site.");
  if (!receiptAllowed(request.headers)) return refused(429, "Too many receipts. Please try again in an hour.");
  const read = await readCappedBody(request, 16_384, { timeoutMs: 5_000 });
  if (!read.ok) return refused(413, "This form is too large or took too long.");
  try {
    const input: unknown = JSON.parse(new TextDecoder().decode(read.body));
    if (!input || typeof input !== "object" || !("token" in input) || typeof input.token !== "string") return refused(400, "This receipt link is missing.");
    const shop = await receiptShop(getDb(), input.token, secret("SESSION_SECRET"));
    if (!shop) return refused(404, "This receipt link is no longer available.");
    const saved = await createReceipt(getDb(), shop.id, input, secret("SHOP_DATA_KEY"));
    return Response.json({ deletePath: `/s/delete/${saved.deleteToken}` }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof ReceiptRefused) return refused(err.code === "NO_SHOP" ? 404 : 400, err.code === "CONSENT" ? "Tick the box to ask for recall updates." : "Check the item and email, then try again.");
    if (err instanceof SyntaxError) return refused(400, "This form could not be read.");
    // Database errors can contain parameter values. Never log them or return them to the browser.
    return refused(503, "Your receipt could not be saved. Please try again.");
  }
}
