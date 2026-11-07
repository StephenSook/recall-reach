import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Problem = {
  error: string;
};

export const problemSchema: Schema<Problem> = s.object<Problem>({
  error: s.string(),
});
