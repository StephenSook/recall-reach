import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type ProblemError = {
  error: string;
};

export const problemErrorSchema: Schema<ProblemError> = s.object<ProblemError>({
  error: s.string(),
});
