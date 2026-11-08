// What an owner sees after a PayPal sign-in. Signed-out answers go to /check by code, so only these sentences can show.
export const OWNER_CODES = {
  OWNER_NOT_SET_UP: "Signing in with PayPal isn't set up on this site yet.",
  OWNER_NOT_LINKED: "That PayPal login doesn't open a shop here. Open your shop from the browser you used, then link your PayPal login from your queue.",
  OWNER_SHOP_GONE: "That shop has been deleted, so there's nothing to open.",
  OWNER_EXPIRED: "That sign-in took too long, was already used, or didn't start here. Press the PayPal button again.",
  OWNER_CANCELLED: "You left PayPal's page without signing in.",
  OWNER_FAILED: "PayPal didn't confirm the sign-in. Press the PayPal button again in a minute.",
  OWNER_BUSY: "Too many sign-ins from here. Try again in a few minutes.",
} as const;
export type OwnerCode = keyof typeof OWNER_CODES;

export const LINKED = {
  LINKED: "Linked. Your shop is now kept until you delete it, or a year passes with no PayPal sign-in or link. Next time, Sign in with PayPal on the Check page opens it.",
  ALREADY_LINKED: "That PayPal login already opens this shop.",
  LINKED_ELSEWHERE: "That PayPal login already opens another shop here. Unlink it there first.",
  NOT_A_REAL_SHOP: "A demo shop can't be linked to a PayPal login.",
  RACED: "Another PayPal login was linked to this shop at the same moment, and that one stands. Check the queue, then try again if you need to.",
} as const;
