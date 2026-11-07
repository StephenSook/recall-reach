import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

export type Database = {
  ok: boolean;
};

export const databaseSchema: Schema<Database> = s.object<Database>({
  ok: s.boolean(),
});
