import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { outcomeSchema, type Outcome } from "./outcome.js";

export type Recall1 = {
  recallNumber: string;
  recallTitle: string;
  outcome: Outcome;
  itemTitle?: string | null;
  reason?: string | null;
};

export const recall1Schema: Schema<Recall1> = s.object<Recall1>({
  recallNumber: s.string(),
  recallTitle: s.string(),
  outcome: outcomeSchema,
  itemTitle: s.optionalNullable(s.string()),
  reason: s.optionalNullable(s.string()),
});
