import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { countsSchema, type Counts } from "./counts.js";
import { searchSchema, type Search } from "./search.js";

export type Proof = {
  runId: string;
  ranAt: Date;
  stored: Counts;
  recomputed: Counts;
  agree: boolean;
  sameRecalls: boolean;
  ms: number;
  search: Search;
  recallYearsMissing: number[];
};

export const proofSchema: Schema<Proof> = s.object<Proof>({
  runId: s.string(),
  ranAt: s.dateTime(),
  stored: countsSchema,
  recomputed: countsSchema,
  agree: s.boolean(),
  sameRecalls: s.boolean(),
  ms: s.int(),
  search: searchSchema,
  recallYearsMissing: s.array(s.int()),
});
