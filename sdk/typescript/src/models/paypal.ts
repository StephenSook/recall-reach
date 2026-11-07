import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { toolkitSchema, type Toolkit } from "./toolkit.js";

/** PayPal's sandbox, and the Agent Toolkit that sends each refund. */
export type Paypal = {
  /** @default "sandbox" */
  environment?: "sandbox";
  webhookConfigured: boolean;
  lastVerifiedWebhookAt: Date | null;
  /**
   * Read from the installed package. The tools read as null until this server has loaded it, about
   * 15 seconds after it starts.
   */
  toolkit: Toolkit;
};

export const paypalSchema: Schema<Paypal> = s.object<Paypal>({
  environment: s.defaulted(s.literal("sandbox"), "sandbox"),
  webhookConfigured: s.boolean(),
  lastVerifiedWebhookAt: s.nullable(s.dateTime()),
  toolkit: toolkitSchema,
});
