import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";

/**
 * Read from the installed package. The tools read as null until this server has loaded it, about 15
 * seconds after it starts.
 */
export type Toolkit = {
  version: string | null;
  loaded: boolean;
  tools: string[] | null;
  baseUrl: string | null;
  runs: string;
};

export const toolkitSchema: Schema<Toolkit> = s.object<Toolkit>({
  version: s.nullable(s.string()),
  loaded: s.boolean(),
  tools: s.nullable(s.array(s.string())),
  baseUrl: s.nullable(s.string()),
  runs: s.string(),
});
