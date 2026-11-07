import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { rowSchema, type Row } from "./row.js";

export type ReplayRun = {
  runId: string;
  ms: number;
  createdAt: Date;
  counts: Record<string, unknown>;
  search: Record<string, unknown>;
  recallYearsMissing: number[];
  rows: Row[];
};

export const replayRunSchema: Schema<ReplayRun> = s.object<ReplayRun>({
  runId: s.string(),
  ms: s.int(),
  createdAt: s.dateTime(),
  counts: s.record(s.string(), s.unknown()),
  search: s.record(s.string(), s.unknown()),
  recallYearsMissing: s.array(s.int()),
  rows: s.array(s.lazy(() => rowSchema)),
});
