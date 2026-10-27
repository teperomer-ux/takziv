/**
 * Pure queries over the user's transactions, used by the AI assistant's
 * tools (in the app and in the server). Everything the assistant says
 * about money comes from these functions, so they follow the app's own rules:
 *  - expenses belong to their billing month (as on the dashboard), incomes
 *    to their calendar month;
 *  - rows in a category flagged as excluded (internal transfers) are not
 *    part of income or spending totals, but are reported separately.
 */

export type RowKind = "expense" | "income";
/** Where an expense was paid from: the עו״ש account or a credit card. Incomes are always "bank". */
export type RowAccount = "bank" | "card";

export interface FinanceRow {
  kind: RowKind;
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM the app lists the row under. */
  month: string;
  description: string;
  /** Positive; a card refund is a negative expense. */
  amount: number;
  category: string;
  subCategory: string;
  account: RowAccount;
  /** max / isracard / cal for card rows; absent for bank rows and legacy uploads. */
  provider?: string;
  /** In a category left out of the totals (e.g. internal transfers). */
  excluded: boolean;
}

export interface RowFilter {
  kind?: RowKind;
  /** YYYY-MM */
  month?: string;
  /** YYYY-MM, inclusive */
  fromMonth?: string;
  /** YYYY-MM, inclusive */
  toMonth?: string;
  account?: RowAccount;
  /** Exact category name, or part of one when no category has that exact name. */
  category?: string;
  /** Part of the description; case, spacing and quote marks are ignored. */
  text?: string;
  minAmount?: number;
  maxAmount?: number;
  /** Include internal transfers and other excluded rows. Default true. */
  includeExcluded?: boolean;
  /** Match months by the purchase date instead of the billing month. */
  byPurchaseDate?: boolean;
}

/** Rounds to the agora so sums of floats don't print as 1234.5600000001. */
export const roundAgorot = (n: number) => Math.round(n * 100) / 100;

function normalize(s: string) {
  return s
    .normalize("NFKC")
    .replace(/["'״׳`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The category names `query` refers to: the exact one if it exists, otherwise every name containing it. */
export function resolveCategories(rows: readonly FinanceRow[], query: string): Set<string> {
  const wanted = normalize(query);
  const names = new Set(rows.map((r) => r.category).filter(Boolean));
  const exact = [...names].filter((n) => normalize(n) === wanted);
  if (exact.length) return new Set(exact);
  return new Set([...names].filter((n) => normalize(n).includes(wanted)));
}

export function filterRows(rows: readonly FinanceRow[], filter: RowFilter): FinanceRow[] {
  const categories = filter.category ? resolveCategories(rows, filter.category) : null;
  const text = filter.text ? normalize(filter.text) : null;
  const monthOf = (r: FinanceRow) => (filter.byPurchaseDate ? r.date.slice(0, 7) : r.month);
  return rows.filter(
    (r) =>
      (!filter.kind || r.kind === filter.kind) &&
      (!filter.month || monthOf(r) === filter.month) &&
      (!filter.fromMonth || monthOf(r) >= filter.fromMonth) &&
      (!filter.toMonth || monthOf(r) <= filter.toMonth) &&
      (!filter.account || r.account === filter.account) &&
      (!categories || categories.has(r.category)) &&
      (!text || normalize(r.description).includes(text)) &&
      (filter.minAmount === undefined || r.amount >= filter.minAmount) &&
      (filter.maxAmount === undefined || r.amount <= filter.maxAmount) &&
      (filter.includeExcluded !== false || !r.excluded),
  );
}

export interface Totals {
  count: number;
  /** What counts toward income / spending. */
  counted: number;
  /** Internal transfers and other excluded categories. */
  excluded: number;
  /** Part of `counted` with no category yet. */
  uncategorized: number;
}

export function totals(rows: readonly FinanceRow[]): Totals {
  const t: Totals = { count: rows.length, counted: 0, excluded: 0, uncategorized: 0 };
  for (const r of rows) {
    if (r.excluded) t.excluded += r.amount;
    else {
      t.counted += r.amount;
      if (!r.category) t.uncategorized += r.amount;
    }
  }
  return { count: t.count, counted: roundAgorot(t.counted), excluded: roundAgorot(t.excluded), uncategorized: roundAgorot(t.uncategorized) };
}

export interface CategoryTotal {
  /** "" for rows with no category. */
  category: string;
  total: number;
  count: number;
  excluded: boolean;
  subCategories: { subCategory: string; total: number; count: number }[];
}

/** Totals per category and sub-category, largest first. */
export function categoryTotals(rows: readonly FinanceRow[]): CategoryTotal[] {
  const byCategory = new Map<string, { total: number; count: number; excluded: boolean; subs: Map<string, { total: number; count: number }> }>();
  for (const r of rows) {
    const c = byCategory.get(r.category) ?? { total: 0, count: 0, excluded: r.excluded, subs: new Map() };
    c.total += r.amount;
    c.count++;
    const s = c.subs.get(r.subCategory) ?? { total: 0, count: 0 };
    s.total += r.amount;
    s.count++;
    c.subs.set(r.subCategory, s);
    byCategory.set(r.category, c);
  }
  return [...byCategory]
    .map(([category, c]) => ({
      category,
      total: roundAgorot(c.total),
      count: c.count,
      excluded: c.excluded,
      subCategories: [...c.subs]
        .map(([subCategory, s]) => ({ subCategory, total: roundAgorot(s.total), count: s.count }))
        .sort((a, b) => b.total - a.total),
    }))
    .sort((a, b) => b.total - a.total);
}

/** The `limit` largest rows by amount (ties: newest first). */
export function largestRows(rows: readonly FinanceRow[], limit: number): FinanceRow[] {
  return [...rows].sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date)).slice(0, limit);
}

export interface MonthSummary {
  month: string;
  expenses: Totals & { bank: number; card: number };
  incomes: Totals;
  /** Counted income minus counted spending. */
  balance: number;
  topExpenseCategories: { category: string; total: number }[];
}

export function monthSummary(rows: readonly FinanceRow[], month: string, byPurchaseDate = false): MonthSummary {
  const inMonth = filterRows(rows, { month, byPurchaseDate });
  const expenses = inMonth.filter((r) => r.kind === "expense");
  const incomes = inMonth.filter((r) => r.kind === "income");
  const counted = (account: RowAccount) =>
    roundAgorot(expenses.filter((r) => !r.excluded && r.account === account).reduce((s, r) => s + r.amount, 0));
  const expenseTotals = totals(expenses);
  const incomeTotals = totals(incomes);
  return {
    month,
    expenses: { ...expenseTotals, bank: counted("bank"), card: counted("card") },
    incomes: incomeTotals,
    balance: roundAgorot(incomeTotals.counted - expenseTotals.counted),
    topExpenseCategories: categoryTotals(expenses.filter((r) => !r.excluded))
      .slice(0, 5)
      .map(({ category, total }) => ({ category, total })),
  };
}

/** Months that have any rows, newest first, with row counts per side. */
export function availableMonths(rows: readonly FinanceRow[]) {
  const months = new Map<string, { expenses: number; incomes: number }>();
  for (const r of rows) {
    const m = months.get(r.month) ?? { expenses: 0, incomes: 0 };
    if (r.kind === "expense") m.expenses++;
    else m.incomes++;
    months.set(r.month, m);
  }
  return [...months].map(([month, counts]) => ({ month, ...counts })).sort((a, b) => b.month.localeCompare(a.month));
}
