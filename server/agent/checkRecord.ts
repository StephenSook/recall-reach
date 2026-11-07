// What the seller's "Check with Claude" button does for one sale: the recall's question, then the sale's finding.
// Neither changes a verdict. If Claude can't answer, the queue stays as it was and says so.
import type Anthropic from "@anthropic-ai/sdk";
import type { Queryable } from "../db/types";
import { OWN_SHOP_CAP_MICROS, spentToday } from "./claude";
import { openRecallsFor, runAgentOnRecord, MAX_RECALLS_PER_RECORD } from "./recallAgent";
import { writeRecallQuestion } from "./recallQuestion";

export interface RecordCheck {
  unavailable: boolean;
  overBudget: boolean;
  failedStatuses: number[];
}

export async function checkRecordWithClaude(db: Queryable, client: Anthropic, input: { shopId: string; recordId: string; now: Date }): Promise<RecordCheck> {
  const { rows: shops } = await db.query<{ kind: string }>("select kind from shops where id = $1", [input.shopId]);
  if (shops[0]?.kind !== "DEMO" && (await spentToday(db, input.now)) >= OWN_SHOP_CAP_MICROS) return { unavailable: false, overBudget: true, failedStatuses: [] };
  const recalls = (await openRecallsFor(db, input.shopId, input.recordId)).slice(0, MAX_RECALLS_PER_RECORD);
  const written = await Promise.all(recalls.map((r) => writeRecallQuestion(db, client, { recallId: r.recall_id, now: input.now })));
  const checked = await runAgentOnRecord(db, client, input);
  return {
    unavailable: written.includes("UNAVAILABLE") || checked.unavailable > 0,
    overBudget: written.includes("OVER_BUDGET") || checked.overBudget > 0,
    failedStatuses: checked.failedStatuses,
  };
}
