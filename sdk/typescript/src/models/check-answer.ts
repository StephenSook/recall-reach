import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { checkResultSchema, type CheckResult } from "./check-result.js";
import { checkedSchema, type Checked } from "./checked.js";
import { mentionedSchema, type Mentioned } from "./mentioned.js";

export type CheckAnswer = {
  results: CheckResult[];
  /** Recalls found past the ones listed. */
  more: number;
  /** Recalls that came near and were ruled out, so they aren't listed. */
  cleared: number;
  /**
   * Recalls that came near but weren't judged, because too many did. Above zero, an empty list
   * doesn't mean nothing was found.
   */
  notJudged: number;
  /**
   * Past the results, recalls whose text has what was given. A maker or a product word given alone
   * ends up here, so an empty results list isn't the same as nothing near. Only looked for when no
   * recall is tied to the text.
   */
  mentioned: Mentioned;
  checked: Checked;
  note: string;
};

export const checkAnswerSchema: Schema<CheckAnswer> = s.object<CheckAnswer>({
  results: s.array(s.lazy(() => checkResultSchema)),
  more: s.int(),
  cleared: s.int(),
  notJudged: s.int(),
  mentioned: mentionedSchema,
  checked: checkedSchema,
  note: s.string(),
});
