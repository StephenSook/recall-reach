import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { databaseSchema, type Database } from "./database.js";

export type HealthDownError = {
  ok: boolean;
  database: Database;
};

export const healthDownErrorSchema: Schema<HealthDownError> = s.object<HealthDownError>({
  ok: s.boolean(),
  database: databaseSchema,
});
