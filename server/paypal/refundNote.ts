// The note that goes to PayPal with a refund, which the buyer sees in their PayPal history and email. Built from CPSC's
// record of the recall the person approved, and nothing about the shop, the sale or the buyer.

/** PayPal's limit on a refund's note_to_payer. */
export const NOTE_LIMIT = 255;

const START = "Refund for a recalled product. CPSC recall ";
const END = " Follow the recall steps at cpsc.gov/Recalls.";

export function refundNote(recallNumber: string, product: string): string {
  // Only the product's name gets shorter, at a word, so the recall and where to go stay whole.
  const room = NOTE_LIMIT - START.length - recallNumber.length - ": .".length - END.length;
  let name = product.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  if (name.length > room) {
    const cut = name.slice(0, room);
    name = (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[\s,;:.-]+$/, "");
  }
  return `${START}${recallNumber}: ${name}.${END}`;
}
