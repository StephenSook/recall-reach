// The exact words a family reads. Wording is from research/COPY-DECK.md; hazard and remedy text is
// copied verbatim from the stored CPSC record and never rewritten. Transactional content only:
// no promotions, and the shop sends it from its own mail client.
import type { Recall } from "../cpsc/schema";
import { modelTokens } from "../match/verdict";

export interface NoticeContext {
  recall: Pick<Recall, "recallNumber" | "url" | "products" | "hazards" | "remedies">;
  itemTitle: string;
  shopName: string;
  orderDate: string;
  familyUrl: string;
}

export interface ComposedMessage {
  subject: string;
  body: string;
}

export function composeSafetyNotice(c: NoticeContext & { confirmedRefund?: string }): ComposedMessage {
  const product = c.recall.products[0]?.name ?? c.itemTitle;
  const lines = [
    "Hi,",
    "",
    `You bought ${c.itemTitle} from ${c.shopName} on ${c.orderDate}. The U.S. Consumer Product Safety Commission (CPSC) has announced a recall of this product.`,
    "",
    "The hazard, in CPSC's words:",
    c.recall.hazards.join("\n\n"),
    "",
    "What to do, in CPSC's words:",
    c.recall.remedies.join("\n\n"),
    "",
    `CPSC recall ${c.recall.recallNumber}: ${c.recall.url}`,
    `More details and steps: ${c.familyUrl}`,
    "",
    ...(c.confirmedRefund
      ? [`PayPal confirmed a refund of ${c.confirmedRefund} to your original payment. Please still follow the recall safety steps above.`, ""]
      : []),
    "We're passing this along because you bought this item from us. This isn't the official recall notice, and it isn't marketing.",
    "",
    c.shopName,
  ];
  return { subject: `Safety recall: ${product} you bought from ${c.shopName} on ${c.orderDate}`, body: lines.join("\n") };
}

export function composeCheckRequest(c: NoticeContext & { question: string }): ComposedMessage {
  const lines = [
    "Hi,",
    "",
    `You bought ${c.itemTitle} from ${c.shopName} on ${c.orderDate}. A product with a similar name was recalled, and we can't tell from our records whether yours is included.`,
    "",
    `Can you check one thing? ${c.question}`,
    `Tap to answer: ${c.familyUrl}`,
    "",
    `Until you can check, stop using it and keep it out of children's reach. Read the recall details: ${c.recall.url}`,
    "",
    "We're asking because it's a safety question, and this isn't marketing.",
    "",
    c.shopName,
  ];
  return { subject: `Quick safety check on ${c.itemTitle} you bought from ${c.shopName}`, body: lines.join("\n") };
}

export interface CheckQuestion {
  question: string;
  kind: "yes_no" | "model" | "general";
}

// Hand-written questions for recalls whose record offers no identifier. Each is used only while the
// phrase it rests on is in the stored CPSC description, so a question can never outlive its source.
const CURATED: Record<string, { question: string; evidence: string }> = {
  "27040": { question: "Does your high chair convert into a table and chair set?", evidence: "convert into a table and chair set" },
};

/** The one thing to ask this family, specific to what this recall can be told apart by. */
export function checkQuestion(recall: Pick<Recall, "recallNumber" | "title" | "description">): CheckQuestion {
  const curated = CURATED[recall.recallNumber];
  if (curated && recall.description.includes(curated.evidence)) return { question: curated.question, kind: "yes_no" };
  const models = modelTokens(`${recall.title} ${recall.description}`);
  if (models.length > 0) return { question: `What model number is on the label? CPSC lists ${models.join(", ")}.`, kind: "model" };
  return { question: "Does yours look like the product on CPSC's recall page?", kind: "general" };
}
