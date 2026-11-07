import { notFound } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { familyView } from "@/server/notice/store";
import { noticeIdFromToken } from "@/server/notice/token";
import { secret } from "@/server/web/http";
import { FamilyNotice } from "../FamilyNotice";

export const dynamic = "force-dynamic";

export default async function FamilyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const noticeId = noticeIdFromToken(secret("SESSION_SECRET"), token);
  const view = noticeId ? await familyView(getDb(), noticeId) : null;
  if (!view) notFound();
  return <FamilyNotice view={view} action={`/api/family/${token}`} />;
}
