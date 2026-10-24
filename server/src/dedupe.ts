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

/** A stored row as the duplicate cleanup sees it. */
export interface StoredRow extends ExistingRow {
  /** Written by the bank sync (deterministic id) rather than the former file uploader. */
  synced: boolean;
  category: string;
  subCategory: string;
}

export interface CleanupGroup {
  key: string;
  kept: StoredRow;
  removed: StoredRow[];
}

export interface CleanupPlan {
  /** Copies of one transaction: everything but `kept` can be deleted. */
  groups: CleanupGroup[];
  /**
   * Identical rows that may be genuinely separate transactions — the bank
   * sync itself reported them more than once (two coffees on one day). Left
   * alone; shown for the user to check.
   */
  review: StoredRow[][];
}

/**
 * Finds rows that are copies of one transaction: same source, date, amount
 * (to the agora) and description. These come from the former file uploader,
 * which gave every row a random id, so uploading a statement twice stored it
 * twice.
 *
 * A group is collapsed to one row only when the sync confirms there was at
 * most one such transaction (at most one synced row on that date with that
 * amount). Synced rows are preferred as the copy to keep — their id is what a
 * re-sync looks for; otherwise the copy whose category differs from the rest,
 * since identical uploads start out identical and that one was edited.
 */
export function planDuplicateCleanup(rows: StoredRow[]): CleanupPlan {
  const groups = new Map<string, StoredRow[]>();
  for (const row of rows) {
    const key = `${row.source ?? ""}|${contentKey(row.date, row.amount, row.description)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const plan: CleanupPlan = { groups: [], review: [] };
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const syncedTwins = rows.filter(
      (r) =>
        r.synced &&
        r.date === group[0].date &&
        Math.round(r.amount * 100) === Math.round(group[0].amount * 100) &&
        (!group[0].source || r.source === group[0].source),
    ).length;
    if (syncedTwins >= 2) {
      plan.review.push(group);
      continue;
    }

    const label = (r: StoredRow) => `${r.category}|${r.subCategory}`;
    const counts = new Map<string, number>();
    for (const r of group) counts.set(label(r), (counts.get(label(r)) ?? 0) + 1);
    const ranked = [...group].sort(
      (a, b) =>
        Number(b.synced) - Number(a.synced) ||
        counts.get(label(a))! - counts.get(label(b))! ||
        a.id.localeCompare(b.id),
    );
    plan.groups.push({ key, kept: ranked[0], removed: ranked.slice(1) });
  }
  return plan;
}
