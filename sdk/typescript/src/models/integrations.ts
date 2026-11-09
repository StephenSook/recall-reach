import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { row1Schema, type Row1 } from "./row1.js";
import { summarySchema, type Summary } from "./summary.js";

/**
 * One row per outside service. A row says live only after its own check passed; client means it
 * runs only in the browser.
 */
export type Integrations = {
  summary: Summary;
  rows: Row1[];
};

export const integrationsSchema: Schema<Integrations> = s.object<Integrations>({
  summary: summarySchema,
  rows: s.array(s.lazy(() => row1Schema)),
});
