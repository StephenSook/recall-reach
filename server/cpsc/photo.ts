/** CPSC's first photo, if CPSC serves it. A page shows it straight from there, so nothing else in a record gets shown as one. */
export function cpscPhoto(images: { url: string; caption: string }[] | null | undefined): { url: string; caption: string } | null {
  const first = images?.[0];
  if (!first) return null;
  try {
    const { protocol, hostname } = new URL(first.url);
    return protocol === "https:" && (hostname === "cpsc.gov" || hostname.endsWith(".cpsc.gov")) ? first : null;
  } catch {
    return null;
  }
}
