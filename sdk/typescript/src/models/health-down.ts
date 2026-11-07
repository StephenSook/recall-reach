import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { databaseSchema, type Database } from "./database.js";

export type HealthDown = {
  ok: boolean;
  database: Database;
};

export const healthDownSchema: Schema<HealthDown> = s.object<HealthDown>({
  ok: s.boolean(),
  database: databaseSchema,
});
