// A quote is the exact words of a source. Spacing and typography may differ from CPSC's. Words, order and case may not.
export const normalized = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, "-")
    .replace(/\s+/g, " ")
    .trim();

export const quoted = (texts: string[], quote: string) => {
  const wanted = normalized(quote);
  return wanted.length >= 3 && texts.some((t) => normalized(t).includes(wanted));
};
