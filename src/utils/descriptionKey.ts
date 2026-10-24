/**
 * Normalised matching key for a transaction description. Banks embed
 * changing parts in otherwise identical descriptions ("משכורת 09/26",
 * "העברה 4471823 מיוסי"), so digits and punctuation are dropped and only the
 * words are kept: both variants above reduce to the same key as the month
 * before. Shared by the app and the sync server.
 */
export function descriptionKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^\p{L}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface LearnedRule {
  description: string;
  category: string;
  subCategory: string;
}

/** True when a learned rule's description applies to this transaction. */
export function ruleMatches(ruleDescription: string, description: string): boolean {
  const ruleKey = descriptionKey(ruleDescription);
  // Rules with no words left (e.g. a bare reference number) keep the old
  // raw substring match rather than matching everything.
  if (!ruleKey) {
    const raw = ruleDescription.trim().toLowerCase();
    return raw !== "" && description.toLowerCase().includes(raw);
  }
  return descriptionKey(description).includes(ruleKey);
}

/**
 * The learned rule that best fits a description: the most specific one
 * (longest key) when several match, so "העברה מיוסי" beats "העברה".
 */
export function findLearnedRule<T extends LearnedRule>(description: string, rules: T[] | undefined): T | undefined {
  let best: T | undefined;
  let bestLength = -1;
  for (const rule of rules ?? []) {
    if (!rule.category || !ruleMatches(rule.description, description)) continue;
    const length = descriptionKey(rule.description).length || rule.description.length;
    if (length > bestLength) {
      best = rule;
      bestLength = length;
    }
  }
  return best;
}
