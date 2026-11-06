// A quote is the exact words of a source. Spacing and typography may differ from CPSC's. Words, order and case may not.
export const normalized = (text: string) =>
  text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Every field of a recall record a quote can come from. */
export function recallWords(recall: {
  title: string;
  description: string;
  products?: { name: string; model: string; type?: string | null }[];
  hazards?: string[];
  remedies?: string[];
}): string[] {
  const products = (recall.products ?? []).flatMap((p) => [p.name, p.model, p.type ?? ""]);
  return [recall.title, recall.description, ...products, ...(recall.hazards ?? []), ...(recall.remedies ?? [])].filter(Boolean);
}

export const quoted = (texts: string[], quote: string) => {
  const wanted = normalized(quote);
  return wanted.length >= 3 && texts.some((t) => normalized(t).includes(wanted));
};
