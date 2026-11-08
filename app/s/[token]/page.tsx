import { notFound } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { receiptShop } from "@/server/safetyReceipt/store";
import { ranAt } from "@/app/replay/labels";
import { secret } from "@/server/web/http";
import { ReceiptForm } from "../ReceiptForm";

export const dynamic = "force-dynamic";

export default async function SafetyReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const shop = await receiptShop(getDb(), (await params).token, secret("SESSION_SECRET"));
  if (!shop) notFound();
  return <ReceiptForm token={(await params).token} shopName={shop.name} demo={shop.kind === "DEMO"} deletesAfter={ranAt(shop.deletesAfter.toISOString())} />;
}
