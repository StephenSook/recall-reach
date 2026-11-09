import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { modeSchema, type Mode } from "./mode.js";

export type Row1 = {
  id: string;
  name: string;
  mode: Mode;
  detail: string;
  checkedAt: Date | null;
};

export const row1Schema: Schema<Row1> = s.object<Row1>({
  id: s.string(),
  name: s.string(),
  mode: modeSchema,
  detail: s.string(),
  checkedAt: s.nullable(s.dateTime()),
});
