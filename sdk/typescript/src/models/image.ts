import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Image = {
  url: string;
  caption: string;
};

export const imageSchema: Schema<Image> = s.object<Image>({
  url: s.string(),
  caption: s.string(),
});
