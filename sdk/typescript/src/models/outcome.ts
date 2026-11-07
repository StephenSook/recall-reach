import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

export const Outcome = {
  Match: "MATCH",
  ScopeGap: "SCOPE_GAP",
  Cleared: "CLEARED",
  NotNear: "NOT_NEAR",
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome] | (string & {});

export const outcomeSchema: EnumSchema<Outcome> = s.enumOf<Outcome>(Outcome);
