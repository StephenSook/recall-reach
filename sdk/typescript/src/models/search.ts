import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Search = {
  windows: number;
  failedWindows: number;
  complete: boolean;
};

export const searchSchema: Schema<Search> = s.object<Search>({
  windows: s.int(),
  failedWindows: s.int(),
  complete: s.boolean(),
});
