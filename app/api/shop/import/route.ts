import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { importOwnFile, MAX_FILE_BYTES, OWN_FILE_DAYS, OwnFileRefused } from "@/server/import/ownFile";
import { businessDay } from "@/server/time/businessDay";
import { fromThisSite, refused, secret, seeOther, signIn, withMessage } from "@/server/web/http";
import { ownCheckAllowed } from "@/server/web/ownCheck";

export const dynamic = "force-dynamic";

/** Room for the form around the file. */
const FORM_OVERHEAD = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const back = (code: string) => seeOther(request, `/check?error=${code}`);
  if (!ownCheckAllowed(request.headers)) return back("BUSY");

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
    const response = rejected > 0 ? withMessage(request, `Read ${lines} lines. ${rejected} ${rejected === 1 ? "row" : "rows"} could not be read.`) : seeOther(request, "/queue");
    // As long as the file is kept, so the shop can come back and see a recall that arrived after it uploaded.
    return signIn(request, response, shopId, OWN_FILE_DAYS * 86_400_000);
  } catch (err) {
    if (err instanceof OwnFileRefused) return back(err.code);
    // The shop's file never reaches a log: only that it failed.
    console.error("own file failed:", err instanceof Error ? err.name : "unknown error");
    return back("FAILED");
  }
}
