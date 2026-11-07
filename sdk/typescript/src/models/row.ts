import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { outcomeSchema, type Outcome } from "./outcome.js";

export type Row = {
  recallNumber: string;
  recallTitle: string;
  recallDate: string;
  outcome: Outcome;
  saleSplit?: string | null;
  itemTitle?: string | null;
  reason?: string | null;
};

export const rowSchema: Schema<Row> = s.object<Row>({
  recallNumber: s.string(),
  recallTitle: s.string(),
  recallDate: s.string(),
  outcome: outcomeSchema,
  saleSplit: s.optionalNullable(s.string()),
  itemTitle: s.optionalNullable(s.string()),
  reason: s.optionalNullable(s.string()),
});
