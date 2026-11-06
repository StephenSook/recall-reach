import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { importOwnFile, MAX_FILE_BYTES, OwnFileRefused } from "@/server/import/ownFile";
import { sessionCookie, SESSION_COOKIE } from "@/server/session/session";
import { businessDay } from "@/server/time/businessDay";
import { baseUrl, fromThisSite, refused, secret, seeOther, withMessage } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

// A file is compared with every recall, so this is limited per visitor and for everyone together.
const perVisitor = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 });
const everyone = createRateLimiter({ limit: 30, windowMs: 60 * 60_000 });
/** Room for the form around the file. */
const FORM_OVERHEAD = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const back = (code: string) => seeOther(request, `/check?error=${code}`);
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor) || !everyone("all")) return back("BUSY");

  const read = await readCappedBody(request, MAX_FILE_BYTES + FORM_OVERHEAD);
  if (!read.ok) return back("TOO_BIG");
  try {
    const form = await new Response(read.body as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    const file = form.get("file");
    if (!(file instanceof File)) return back("NOT_READABLE");
    const { shopId, lines, rejected } = await importOwnFile(getDb(), {
      shopName: String(form.get("shopName") ?? ""),
      csv: await file.text(),
      secret: secret("SHOP_DATA_KEY"),
      today: businessDay(),
    });
    const { value } = sessionCookie(secret("SESSION_SECRET"), shopId);
    const response = rejected > 0 ? withMessage(request, `Read ${lines} lines. ${rejected} ${rejected === 1 ? "row" : "rows"} could not be read.`) : seeOther(request, "/queue");
    const secure = baseUrl(request).startsWith("https:") ? "; Secure" : "";
    response.headers.append("Set-Cookie", `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`);
    return response;
  } catch (err) {
    if (err instanceof OwnFileRefused) return back(err.code);
    // The shop's file never reaches a log: only that it failed.
    console.error("own file failed:", err instanceof Error ? err.name : "unknown error");
    return back("FAILED");
  }
}
