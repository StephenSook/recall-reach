import { getDb } from "@/server/db/pg";
import { readSentLedger, sentLedgerCsv } from "@/server/paypal/sentLedger";
import { currentSession, refused } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await currentSession();
  if (!session) return refused(401, "sign in as a shop first");
  const rows = await readSentLedger(getDb(), session.shopId);
  return new Response(sentLedgerCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="recall-reach-refunds.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
