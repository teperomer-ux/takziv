// ─── Category status helpers ─────────────────────────────────────────────────
// Shared logic for deciding whether an expense still needs manual sorting and
// for floating those rows to the top of import / expense lists.

/**
 * Sentinel category values that mean "not really categorized".
 * Empty string is the normal placeholder, but some imports / legacy data
 * store an explicit label instead — treat those as uncategorized too.
 */
const UNCATEGORIZED_LABELS = new Set(["לא מסווג", "uncategorized"]);

/**
 * A row counts as uncategorized when it has no real category assigned:
 * missing, null/undefined, whitespace-only, or an explicit placeholder label.
 */
export function isUncategorized(category: string | null | undefined): boolean {
  if (!category) return true;
  const trimmed = category.trim();
  return trimmed === "" || UNCATEGORIZED_LABELS.has(trimmed.toLowerCase());
}

/** Minimal shape needed to order an expense row. */
interface SortableRow {
  category: string | null | undefined;
  date: string; // YYYY-MM-DD
}

/**
 * Sort comparator for `Array.prototype.sort`:
 *   1. Uncategorized rows first (so they float to the top for processing).
 *   2. Newest date first within each group.
 * Dates are compared lexicographically — valid because of the ISO format.
 */
export function byUncategorizedThenDate(a: SortableRow, b: SortableRow): number {
  const aUncat = isUncategorized(a.category) ? 0 : 1;
  const bUncat = isUncategorized(b.category) ? 0 : 1;
  if (aUncat !== bUncat) return aUncat - bUncat;
  return b.date.localeCompare(a.date);
}
