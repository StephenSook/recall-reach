import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Recall = {
  recallNumber: string;
  title: string;
};

export const recallSchema: Schema<Recall> = s.object<Recall>({
  recallNumber: s.string(),
  title: s.string(),
});
