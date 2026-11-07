import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { recallSchema, type Recall } from "./recall.js";

/**
 * Past the results, recalls whose text has what was given. A maker or a product word given alone
 * ends up here, so an empty results list isn't the same as nothing near. Only looked for when no
 * recall is tied to the text.
 */
export type Mentioned = {
  total: number;
  recalls: Recall[];
};

export const mentionedSchema: Schema<Mentioned> = s.object<Mentioned>({
  total: s.int(),
  recalls: s.array(s.lazy(() => recallSchema)),
});
