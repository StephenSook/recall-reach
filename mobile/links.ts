// What the shell lets into its web view. Plain string checks, with no URL parsing, so they behave the same on every engine.
export const SITE = "https://recall-reach-web-e022.onrender.com";
export const QUEUE = `${SITE}/queue`;

const ON_SITE = /^https:\/\/recall-reach-web-e022\.onrender\.com(?:[/?#]|$)/;
/** The sandbox page a family pays on. It has to stay in the same web view to come back to the same session. */
const ON_PAYPAL_SANDBOX = /^https:\/\/www\.sandbox\.paypal\.com(?:[/?#]|$)/;
const CARD_PATH = /^\/queue(?:#sale-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;
const PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

/** The site and PayPal's sandbox page stay here. Anything else, including mail and CPSC's pages, opens outside the app. */
export const staysInApp = (url: string) => url === "about:blank" || ON_SITE.test(url) || ON_PAYPAL_SANDBOX.test(url);

/** Where tapping a push goes. A push is outside input, so only a card on this site's queue is accepted. */
export function urlFromPush(data: unknown): string | null {
  const path = (data as { path?: unknown } | null | undefined)?.path;
  return typeof path === "string" && CARD_PATH.test(path) ? `${SITE}${path}` : null;
}

/** Hands the push token to the site's own page and to no other. The page registers it from inside the shop's session. */
export function tokenScript(token: string): string {
  if (!PUSH_TOKEN.test(token)) return "true;";
  return `if (location.origin === ${JSON.stringify(SITE)}) { window.recallReachPushToken = ${JSON.stringify(token)}; window.dispatchEvent(new Event("recall-reach-push-token")); } true;`;
}
