import { createHmac, timingSafeEqual } from "node:crypto";

const sign = (secret: string, id: string) => createHmac("sha256", secret).update(`family-page\u0000${id}`).digest("base64url");

/** The family page's link. It names a notice and nothing else: no buyer data in the URL. */
export function familyTokenFor(secret: string, noticeId: string): string {
  return `${noticeId}.${sign(secret, noticeId)}`;
}

export function noticeIdFromToken(secret: string, token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}
