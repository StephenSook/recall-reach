import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

export const Shop = {
  Demo: "demo",
} as const;
export type Shop = (typeof Shop)[keyof typeof Shop] | (string & {});

export const shopSchema: EnumSchema<Shop> = s.enumOf<Shop>(Shop);
