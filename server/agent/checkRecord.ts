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
  /** Too many of a shop's own-file checks are running right now. Nothing was asked. */
  busy: boolean;
  failedStatuses: number[];
}

/** The cap is read before a check starts, so what's running can pass it. A few at once keeps that well inside the demo path's share. */
const MAX_OWN_SHOP_AT_ONCE = 3;
let ownShopChecks = 0;

async function runCheck(db: Queryable, client: Anthropic, input: { shopId: string; recordId: string; now: Date }): Promise<RecordCheck> {
  const recalls = (await openRecallsFor(db, input.shopId, input.recordId)).slice(0, MAX_RECALLS_PER_RECORD);
  const written = await Promise.all(recalls.map((r) => writeRecallQuestion(db, client, { recallId: r.recall_id, now: input.now })));
  const checked = await runAgentOnRecord(db, client, input);
  return {
    unavailable: written.includes("UNAVAILABLE") || checked.unavailable > 0,
    overBudget: written.includes("OVER_BUDGET") || checked.overBudget > 0,
    busy: false,
    failedStatuses: checked.failedStatuses,
  };
}

export async function checkRecordWithClaude(db: Queryable, client: Anthropic, input: { shopId: string; recordId: string; now: Date }): Promise<RecordCheck> {
  const { rows: shops } = await db.query<{ kind: string }>("select kind from shops where id = $1", [input.shopId]);
  if (shops[0]?.kind === "DEMO") return runCheck(db, client, input);
  if ((await spentToday(db, input.now)) >= OWN_SHOP_CAP_MICROS) return { unavailable: false, overBudget: true, busy: false, failedStatuses: [] };
  if (ownShopChecks >= MAX_OWN_SHOP_AT_ONCE) return { unavailable: false, overBudget: false, busy: true, failedStatuses: [] };
  ownShopChecks++;
  try {
    return await runCheck(db, client, input);
  } finally {
    ownShopChecks--;
  }
}
