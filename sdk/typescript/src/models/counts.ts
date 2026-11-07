import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Counts = {
  checked: number;
  matched: number;
  scopeGaps: number;
  cleared: number;
  notNear: number;
  noticeOnly: number;
  refundEligible: number;
};

export const countsSchema: Schema<Counts> = s.object<Counts>({
  checked: s.int(),
  matched: s.int(),
  scopeGaps: s.int(),
  cleared: s.int(),
  notNear: s.int(),
  noticeOnly: s.int(),
  refundEligible: s.int(),
});
