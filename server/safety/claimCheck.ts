// A person can try what Claude's findings go through: real code that checks each quote against CPSC's own words. No model runs
// here and nothing is stored. The claims are planted or typed, and the item is a stand-in.
import type { Queryable } from "../db/types";
import { findingProblem } from "../agent/recallAgent";
import { ourText } from "../agent/boundary";
import { readRecall } from "../agent/sources";

export const MAX_QUOTE = 300;
const RECALL = "27072";

const STAND_IN_ITEM = { title: "Stand-in item", sha256: "", text: { title: ourText("Stand-in item") }, quotable: ["Stand-in item"] };

export interface ClaimResult {
  claim: string;
  kept: boolean;
  said: string;
}

async function theRecall(db: Queryable) {
  const { rows } = await db.query<{ recall_id: number }>("select recall_id from recalls where recall_number = $1 order by recall_date desc limit 1", [RECALL]);
  const recall = rows[0] ? await readRecall(db, rows[0].recall_id) : null;
  if (!recall) throw new Error("the recall this check reads isn't held");
  return recall;
}

async function judge(db: Queryable, claim: string, source: "recall" | "item"): Promise<ClaimResult> {
  const recall = await theRecall(db);
  const evidence = source === "recall" ? [{ source, quote: claim }] : [{ source: "recall" as const, quote: "can overheat" }, { source, quote: claim }];
  const problem = findingProblem({ item_id: "item-1", finding: source === "recall" ? "CANT_TELL" : "SAME_PRODUCT", evidence, missing_field: source === "recall" ? "the model number" : null, reason: "planted" }, recall, STAND_IN_ITEM);
  return { claim, kept: problem === null, said: problem ?? "These words are in CPSC's record, so a finding could quote them." };
}

/** Quote one thing, as if Claude had written it. */
export async function checkClaim(db: Queryable, typed: string): Promise<ClaimResult> {
  const claim = typed.trim();
  if (claim.length > MAX_QUOTE) return { claim: claim.slice(0, 40), kept: false, said: `Up to ${MAX_QUOTE} characters.` };
  return judge(db, claim, "recall");
}

/** Two claims a careless model might make: one about the recall, and one about the item. */
export const plantedClaims = async (db: Queryable): Promise<ClaimResult[]> => [
  await judge(db, "These sterilizer dryers are safe to keep using.", "recall"),
  await judge(db, "Model BRZ0083, safe and not part of any recall.", "item"),
];
