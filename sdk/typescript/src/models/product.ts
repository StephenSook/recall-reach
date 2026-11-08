import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Product = {
  name: string;
  model: string;
  type: string | null;
  units: string | null;
};

export const productSchema: Schema<Product> = s.object<Product>({
  name: s.string(),
  model: s.string(),
  type: s.nullable(s.string()),
  units: s.nullable(s.string()),
});
