import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { sampleFamilyView } from "@/server/notice/store";
import { FamilyNotice } from "../FamilyNotice";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "A sample family notice, Recall Reach" };

const SAMPLE_RECALL = "27072";

/** A link that stays good, unlike a demo shop's. Only CPSC's public record, and it reads and writes nothing else. */
export default async function SampleFamilyPage() {
  const view = await sampleFamilyView(getDb(), SAMPLE_RECALL);
  if (!view) notFound();
  return <FamilyNotice view={view} action={null} />;
}
