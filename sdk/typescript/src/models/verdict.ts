import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

/**
 * MATCH means the text shows what the recall names. SCOPE_GAP means it comes close to what the
 * recall names, but the text can't show this item is covered.
 */
export const Verdict = {
  Match: "MATCH",
  ScopeGap: "SCOPE_GAP",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict] | (string & {});

export const verdictSchema: EnumSchema<Verdict> = s.enumOf<Verdict>(Verdict);
