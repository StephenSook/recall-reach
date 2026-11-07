import * as s from "../core/validation/index.js";
import type { Schema } from "../core/validation/schema.js";
import { recall1Schema, type Recall1 } from "./recall1.js";

export type RecallDay = {
  shop: string;
  runId: string;
  recallDate: string | null;
  recalls: Recall1[];
};

export const recallDaySchema: Schema<RecallDay> = s.object<RecallDay>({
  shop: s.string(),
  runId: s.string(),
  recallDate: s.nullable(s.dateOnly()),
  recalls: s.array(s.lazy(() => recall1Schema)),
});
