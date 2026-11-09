// The fixed sentences an owner reads for a follow-up, and the most days each can sit beside. No imports: the queue and the
// page read these too, and nothing here reaches Claude or PayPal.

/** What the owner reads. Fixed sentences, so nothing Claude writes can tell an owner a product is fine. */
export const SEVERITY_SENTENCE = {
  grave_and_fast: "This hazard can seriously injure or kill a child quickly, with little warning.",
  serious: "This hazard can cause serious injury.",
  lesser: "This hazard usually gives some warning or causes minor injury.",
} as const;

export type Severity = keyof typeof SEVERITY_SENTENCE;

/** The most days each sentence can sit beside. A date a month out next to "can kill a child quickly" would read as careless. */
export const MOST_DAYS: Record<Severity, number> = { grave_and_fast: 7, serious: 14, lesser: 30 };

/** The most days for a stored sentence. One that isn't ours gets the widest cap the page allows anyway. */
export function mostDaysFor(reason: string): number {
  const severity = (Object.keys(SEVERITY_SENTENCE) as Severity[]).find((key) => SEVERITY_SENTENCE[key] === reason);
  return severity ? MOST_DAYS[severity] : 30;
}
