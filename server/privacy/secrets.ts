/** Refuses a short secret, and the placeholder .env.example ships, which is long enough to pass and public. */
export function requireSecret(secret: string, what: string): void {
  if (secret.length < 32) throw new Error(`${what} secret must be at least 32 characters`);
  if (secret.startsWith("REPLACE_")) throw new Error(`${what} secret is still the placeholder from .env.example`);
}
