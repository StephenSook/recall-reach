// What an owner sees after a PayPal sign-in. Signed-out answers go to /check by code, so only these sentences can show.
export const OWNER_CODES = {
  OWNER_NOT_SET_UP: "Signing in with PayPal isn't set up on this site yet.",
  OWNER_NOT_LINKED: "That PayPal login doesn't open a shop here. Open your shop from the browser you used, then link your PayPal login from your queue.",
  OWNER_SHOP_GONE: "That shop has been deleted, so there's nothing to open.",
  OWNER_EXPIRED: "That sign-in took too long or didn't start here. Try again.",
  OWNER_CANCELLED: "You left PayPal's page without signing in.",
  OWNER_FAILED: "PayPal didn't confirm the sign-in. Try again in a minute.",
  OWNER_BUSY: "Too many sign-ins from here. Try again in a few minutes.",
} as const;
export type OwnerCode = keyof typeof OWNER_CODES;

export const LINKED = {
  LINKED: "Linked. Next time, Sign in with PayPal on the Check page opens this shop.",
  ALREADY_LINKED: "That PayPal login already opens this shop.",
  LINKED_ELSEWHERE: "That PayPal login already opens another shop here. Unlink it there first.",
  NOT_A_REAL_SHOP: "A demo shop can't be linked to a PayPal login.",
} as const;
