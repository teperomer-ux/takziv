import type { MappedTransaction } from "./transactionMapper.js";

/** A row already in Firestore, reduced to what content matching needs. */
export interface ExistingRow {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  description: string;
  source?: string;
}

const KNOWN_SOURCES = new Set(["max", "isracard", "cal", "bank"]);

/**
 * date + amount (to the agora) + business name, normalised so the same
 * purchase matches whether it came from a CSV upload or a scrape: case,
 * spacing and Hebrew/ASCII quote marks (בע"מ vs בע״מ) are ignored.
 */
export function contentKey(date: string, amount: number, description: string) {
  const name = description
    .normalize("NFKC")
    .replace(/["'״׳`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${date}|${Math.round(amount * 100)}|${name}`;
}

/**
 * Returns the ids of `candidates` that already exist under a different doc id
 * — typically rows imported earlier from a CSV/Excel file, whose ids were
 * random.
 *
 * Matching is one-to-one: two identical coffees on the same day are two rows,
 * so one existing row can absorb only one candidate. Rows from different card
 * providers never match each other; legacy rows without a source match any.
 *
 * `existing` must not include docs whose id is one of the scraped ids (those
 * are already handled by the id check).
 */
export function findContentDuplicates(candidates: MappedTransaction[], existing: ExistingRow[]): Set<string> {
  const pool = new Map<string, ExistingRow[]>();
  for (const row of existing) {
    const key = contentKey(row.date, row.amount, row.description);
    pool.set(key, [...(pool.get(key) ?? []), row]);
  }

  const duplicates = new Set<string>();
  for (const tx of candidates) {
    const rows = pool.get(contentKey(tx.date, tx.amount, tx.description));
    if (!rows) continue;
    const idx = rows.findIndex((r) => !r.source || !KNOWN_SOURCES.has(r.source) || r.source === tx.source);
    if (idx === -1) continue;
    rows.splice(idx, 1);
    duplicates.add(tx.id);
  }
  return duplicates;
}
