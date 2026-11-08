import * as s from "../core/validation/index.js";
import type { EnumSchema } from "../core/validation/schema.js";

export const RetryAfter = {
  _3600: 3600,
} as const;
export type RetryAfter = (typeof RetryAfter)[keyof typeof RetryAfter] | (number & {});

export const retryAfterSchema: EnumSchema<RetryAfter> = s.enumOf<RetryAfter>(RetryAfter);
