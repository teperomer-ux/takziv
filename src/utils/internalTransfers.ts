/**
 * Internal transfers: money moving between the user's own accounts and
 * assets (account-to-account transfers, selling or buying securities,
 * deposits). They show up as credits/debits on the עו״ש statement but are not
 * income or spending, so categories flagged as excluded are left out of the
 * monthly totals. The flag lives on the category, which means the existing
 * description → category learning also learns "this is not income".
 * Shared by the app and the sync server.
 */

import type { ClassificationResult } from "./classifier.js";

export const INTERNAL_TRANSFERS = "העברות פנימיות";

export const INCOME_TRANSFER_SUBCATEGORIES = [
  "העברה בין חשבונות",
  "העברה עצמית",
  "מימוש נייר ערך / השקעה",
  "פדיון פיקדון",
  "הלוואה שהתקבלה",
];

export const EXPENSE_TRANSFER_SUBCATEGORIES = [
  "העברה בין חשבונות",
  "העברה עצמית",
  "קניית נייר ערך / השקעה",
  "הפקדה לפיקדון",
];

/** Category doc fields holding the flag, per side. */
export const INCOME_EXCLUDE_FIELD = "excludeFromIncomeTotals";
export const EXPENSE_EXCLUDE_FIELD = "excludeFromExpenseTotals";

/**
 * Reads a category doc's flag. A doc saved before the flag existed counts as
 * excluded only when it is the built-in internal-transfers category.
 */
export function readExcludeFlag(categoryName: string, flag: unknown): boolean {
  return typeof flag === "boolean" ? flag : categoryName === INTERNAL_TRANSFERS;
}

export interface TotalsSplit {
  /** Rows that count — operating income or real spending (incl. uncategorised). */
  counted: number;
  /** Rows in an excluded category, e.g. internal transfers. */
  excluded: number;
  /** Part of `counted` that has no category yet. */
  uncategorized: number;
}

/** Splits rows' amounts into what counts toward the monthly total and what doesn't. */
export function splitTotals(
  rows: readonly { amount: number; category: string }[],
  excludedCategories: ReadonlySet<string>,
): TotalsSplit {
  const split: TotalsSplit = { counted: 0, excluded: 0, uncategorized: 0 };
  for (const row of rows) {
    if (row.category && excludedCategories.has(row.category)) {
      split.excluded += row.amount;
      continue;
    }
    split.counted += row.amount;
    if (!row.category) split.uncategorized += row.amount;
  }
  return split;
}

/** True when a row belongs to a category that is left out of the totals. */
export function isExcludedFromTotals(category: string, excludedCategories: ReadonlySet<string>): boolean {
  return category !== "" && excludedCategories.has(category);
}

/** What the old generic "העברה" keyword rule assigned to every incoming transfer. */
export const LEGACY_GENERIC_TRANSFER = { category: "העברות מלקוחות", subCategory: "העברה בנקאית" };

/**
 * The new category for an existing row when the current rules are re-applied,
 * or null to leave it alone. A row is changed only when
 *  - it has no category yet, or
 *  - it was categorised by a fixed rule (no learned rule matches it, so the
 *    user never chose its category) and the current rules now say it is an
 *    internal transfer or it still carries the old generic-transfer category.
 * Anything the user categorised themselves is kept.
 */
export function reclassification(
  row: { category: string; subCategory: string },
  suggestion: ClassificationResult | undefined,
): { category: string; subCategory: string } | null {
  if (!suggestion) return null;
  const next = { category: suggestion.category, subCategory: suggestion.subCategory };
  if (!row.category) return next;
  if (suggestion.source === "learned") return null;
  if (row.category === next.category && row.subCategory === next.subCategory) return null;

  const wasLegacyGeneric =
    row.category === LEGACY_GENERIC_TRANSFER.category && row.subCategory === LEGACY_GENERIC_TRANSFER.subCategory;
  return next.category === INTERNAL_TRANSFERS || wasLegacyGeneric ? next : null;
}

/**
 * The excluded set from a categories snapshot. The built-in internal-transfers
 * category stays excluded while its doc doesn't exist (not seeded yet, or
 * deleted while rows still carry the name); only an explicit flag on the doc
 * can turn it back on.
 */
export function withDefaultExclusion(
  categories: Record<string, unknown>,
  excluded: readonly string[],
): ReadonlySet<string> {
  const set = new Set(excluded);
  if (!(INTERNAL_TRANSFERS in categories)) set.add(INTERNAL_TRANSFERS);
  return set;
}
