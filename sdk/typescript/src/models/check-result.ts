import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { verdictSchema, type Verdict } from "./verdict.js";

export type CheckResult = {
  recallNumber: string;
  title: string;
  recallDate: string;
  url?: string | null;
  /**
   * MATCH means the text shows what the recall names. SCOPE_GAP means it comes close to what the
   * recall names, but the text can't show this item is covered.
   */
  verdict: Verdict;
  strength: string;
  /**
   * The text has this recall's model, a code close to it, or its maker and product line. Otherwise
   * it only shares a kind of product.
   */
  tiedToRecall: boolean;
  /**
   * Its text has what was given, all of it or a word few recalls have, so it could be this item.
   * Otherwise it only shares a kind of product. Only set when no recall is tied to the text.
   */
  sharesWords: boolean;
  reason: string;
  /** What it would take to settle a SCOPE_GAP verdict. */
  missing: string[];
};

export const checkResultSchema: Schema<CheckResult> = s.object<CheckResult>({
  recallNumber: s.string(),
  title: s.string(),
  recallDate: s.dateOnly(),
  url: s.optionalNullable(s.string()),
  verdict: verdictSchema,
  strength: s.string(),
  tiedToRecall: s.boolean(),
  sharesWords: s.boolean(),
  reason: s.string(),
  missing: s.array(s.string()),
});
