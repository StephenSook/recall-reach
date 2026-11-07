import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Checks = {
  database: boolean;
  webhook: boolean;
  lastPull: boolean;
  purge: boolean;
  poll: boolean;
  replay: boolean;
  logging: boolean;
};

export const checksSchema: Schema<Checks> = s.object<Checks>({
  database: s.boolean(),
  webhook: s.boolean(),
  lastPull: s.boolean(),
  purge: s.boolean(),
  poll: s.boolean(),
  replay: s.boolean(),
  logging: s.boolean(),
});
