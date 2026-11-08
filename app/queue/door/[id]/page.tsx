import { notFound, redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { readDoorNotice } from "@/server/notice/door";
import { NoticeRefused } from "@/server/notice/store";
import { baseUrl, currentSession } from "@/server/web/http";
import { receiptQr } from "@/server/safetyReceipt/qr";
import { DoorNotice } from "../DoorNotice";
import "../print.css";

export const dynamic = "force-dynamic";

export default async function DoorNoticePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/?demo=noqueue");
  const { id } = await params;
  let notice;
  try {
    notice = await readDoorNotice(getDb(), { shopId: session.shopId, noticeId: id });
  } catch (err) {
    if (err instanceof NoticeRefused) notFound();
    throw err;
  }
  const publicUrl = `${baseUrl()}/recall/${encodeURIComponent(notice.recallNumber)}`;
  const qr = await receiptQr(publicUrl);
  return <DoorNotice notice={notice} noticeId={id} publicUrl={publicUrl} qr={qr} />;
}
