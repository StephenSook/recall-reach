import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

/** CPSC's warnings file, apart from recalls. Not part of ok. */
export type Warnings = {
  count?: number;
  lastOkAt?: Date | null;
  fresh?: boolean;
};

export const warningsSchema: Schema<Warnings> = s.object<Warnings>({
  count: s.optional(s.int()),
  lastOkAt: s.optionalNullable(s.dateTime()),
  fresh: s.optional(s.boolean()),
});
