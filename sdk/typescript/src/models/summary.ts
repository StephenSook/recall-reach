import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Summary = {
  live: number;
  fallback: number;
  off: number;
  client: number;
  of: number;
};

export const summarySchema: Schema<Summary> = s.object<Summary>({
  live: s.int(),
  fallback: s.int(),
  off: s.int(),
  client: s.int(),
  of: s.int(),
});
