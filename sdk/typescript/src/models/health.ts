import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { checksSchema, type Checks } from "./checks.js";
import { databaseSchema, type Database } from "./database.js";
import { degradedSchema, type Degraded } from "./degraded.js";
import { integrationsSchema, type Integrations } from "./integrations.js";
import { marketSchema, type Market } from "./market.js";
import { paypalSchema, type Paypal } from "./paypal.js";
import { warningsSchema, type Warnings } from "./warnings.js";

export type Health = {
  ok: boolean;
  /**
   * One row per outside service. A row says live only after its own check passed; client means it
   * runs only in the browser.
   */
  integrations: Integrations;
  /** The commit this answer came from. */
  build?: string | null;
  /** CPSC's warnings file, apart from recalls. Not part of ok. */
  warnings?: Warnings;
  /** Set when CPSC is the only thing failing. */
  degraded?: Degraded | null;
  checkedAt: Date;
  /** PayPal's sandbox, and the Agent Toolkit that sends each refund. */
  paypal?: Paypal;
  /**
   * The search of the wider market. Not part of ok. Fresh means a search worked in the last 8 days.
   */
  market: Market;
  checks: Checks;
  database: Database;
};

export const healthSchema: Schema<Health> = s.object<Health>({
  ok: s.boolean(),
  integrations: integrationsSchema,
  build: s.optionalNullable(s.string()),
  warnings: s.optional(s.lazy(() => warningsSchema)),
  degraded: s.optionalNullable(s.lazy(() => degradedSchema)),
  checkedAt: s.dateTime(),
  paypal: s.optional(s.lazy(() => paypalSchema)),
  market: marketSchema,
  checks: checksSchema,
  database: databaseSchema,
});
