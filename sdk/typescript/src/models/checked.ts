import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Checked = {
  recalls: number;
  from?: string | null;
  to?: string | null;
  /** Years whose recalls didn't fully load, so this answer may not cover them. */
  yearsMissing: number[];
};

export const checkedSchema: Schema<Checked> = s.object<Checked>({
  recalls: s.int(),
  from: s.optionalNullable(s.dateOnly()),
  to: s.optionalNullable(s.dateOnly()),
  yearsMissing: s.array(s.int()),
});
