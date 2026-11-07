import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

/**
 * The search of the wider market. Not part of ok. Fresh means a search worked in the last 8 days.
 */
export type Market = {
  lastOkAt: Date | null;
  fresh: boolean;
};

export const marketSchema: Schema<Market> = s.object<Market>({
  lastOkAt: s.nullable(s.dateTime()),
  fresh: s.boolean(),
});
