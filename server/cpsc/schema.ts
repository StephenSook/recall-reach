import { z } from "zod";

// CPSC sends timestamps as local "YYYY-MM-DDTHH:MM:SS" with no zone (measured: always midnight).
const CPSC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

function isRealCalendarTime(value: string): boolean {
  const m = CPSC_TIMESTAMP.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === s
  );
}

const cpscTimestamp = z.string().refine(isRealCalendarTime, "expected a real date as YYYY-MM-DDTHH:MM:SS");

const named = z.object({ Name: z.string() });

// Only the fields Recall Reach reads are checked; the full record is kept separately as raw.
const recordSchema = z.object({
  RecallID: z.number().int().positive(),
  RecallNumber: z.string().min(1),
  RecallDate: cpscTimestamp,
  LastPublishDate: cpscTimestamp,
  Title: z.string().min(1),
  Description: z.string(),
  URL: z.string(),
  Products: z.array(
    z.object({
      Name: z.string(),
      Model: z.string(),
      Type: z.string().nullish(),
      NumberOfUnits: z.string().nullish(),
    }),
  ),
  Hazards: z.array(named),
  Remedies: z.array(named),
  RemedyOptions: z.array(z.object({ Option: z.string() })),
  Retailers: z.array(named),
  Images: z.array(z.object({ URL: z.string(), Caption: z.string() })),
});

export interface RecallProduct {
  name: string;
  model: string;
  type: string | null;
  units: string | null;
}

export interface Recall {
  recallId: number;
  recallNumber: string;
  /** Calendar date of the recall, YYYY-MM-DD. */
  recallDate: string;
  /** As CPSC sends it: YYYY-MM-DDTHH:MM:SS, no zone. */
  lastPublishDate: string;
  title: string;
  description: string;
  url: string;
  products: RecallProduct[];
  hazards: string[];
  remedies: string[];
  remedyOptions: string[];
  retailers: string[];
  images: { url: string; caption: string }[];
}

export interface ParsedRecall {
  recall: Recall;
  /** The record exactly as CPSC sent it. */
  raw: unknown;
}

export interface InvalidRecall {
  index: number;
  recallId: number | null;
  issues: string[];
}

export interface ParseResult {
  valid: ParsedRecall[];
  invalid: InvalidRecall[];
}

/**
 * Validates a CPSC Recalls API response. A record that fails validation is reported, never
 * silently dropped; a payload that is not a JSON array (an error object, a challenge page)
 * throws, because nothing in it can be trusted.
 */
export function parseRecalls(payload: unknown): ParseResult {
  if (!Array.isArray(payload)) {
    throw new Error(`CPSC payload is not a JSON array (got ${typeof payload})`);
  }
  const result: ParseResult = { valid: [], invalid: [] };
  payload.forEach((raw, index) => {
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { RecallID?: unknown } | null)?.RecallID;
      result.invalid.push({
        index,
        recallId: typeof id === "number" ? id : null,
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(record)"}: ${i.message}`),
      });
      return;
    }
    const r = parsed.data;
    result.valid.push({
      raw,
      recall: {
        recallId: r.RecallID,
        recallNumber: r.RecallNumber,
        recallDate: r.RecallDate.slice(0, 10),
        lastPublishDate: r.LastPublishDate,
        title: r.Title,
        description: r.Description,
        url: r.URL,
        products: r.Products.map((p) => ({
          name: p.Name,
          model: p.Model,
          type: p.Type ?? null,
          units: p.NumberOfUnits ?? null,
        })),
        hazards: r.Hazards.map((h) => h.Name),
        remedies: r.Remedies.map((h) => h.Name),
        remedyOptions: r.RemedyOptions.map((o) => o.Option),
        retailers: r.Retailers.map((h) => h.Name),
        images: r.Images.map((i) => ({ url: i.URL, caption: i.Caption })),
      },
    });
  });
  return result;
}
