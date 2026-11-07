import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

/** Set when CPSC is the only thing failing. */
export type Degraded = {
  /** @default "CPSC" */
  source?: "CPSC";
  since: Date | null;
  lastGoodAt: Date | null;
};

export const degradedSchema: Schema<Degraded> = s.object<Degraded>({
  source: s.defaulted(s.literal("CPSC"), "CPSC"),
  since: s.nullable(s.dateTime()),
  lastGoodAt: s.nullable(s.dateTime()),
});
