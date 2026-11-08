import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { imageSchema, type Image } from "./image.js";
import { productSchema, type Product } from "./product.js";

export type PublicRecall = {
  found: boolean;
  recallNumber: string;
  title: string;
  recallDate: string;
  url: string;
  description: string;
  products: Product[];
  hazards: string[];
  remedies: string[];
  image: Image | null;
};

export const publicRecallSchema: Schema<PublicRecall> = s.object<PublicRecall>({
  found: s.boolean(),
  recallNumber: s.string(),
  title: s.string(),
  recallDate: s.dateOnly(),
  url: s.string(),
  description: s.string(),
  products: s.array(s.lazy(() => productSchema)),
  hazards: s.array(s.string()),
  remedies: s.array(s.string()),
  image: s.nullable(s.lazy(() => imageSchema)),
});
