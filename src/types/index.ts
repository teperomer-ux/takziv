export type TransactionStatus = "draft" | "confirmed";

/**
 * Where an expense came from. The credit-card slugs identify the specific card
 * provider (used for the bank↔CC reconciliation), and "bank" marks rows that
 * were imported directly from the עו״ש statement.
 *
 * Income rows leave this undefined.
 */
export type TransactionSource = "max" | "isracard" | "cal" | "bank";

export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD (actual purchase date)
  description: string; // בית עסק / תיאור
  amount: number;
  category: string; // סעיף
  subCategory: string; // תת סעיף
  status: TransactionStatus;
  /** Credit-card billing cycle month (1-12). Used for dashboard grouping. */
  billingMonth: number;
  /** Credit-card billing cycle year. Used for dashboard grouping. */
  billingYear: number;
  /**
   * Credit-card provider slug, or "bank" for direct עו״ש rows. Legacy rows
   * imported before this field existed leave it undefined.
   */
  source?: TransactionSource;
}
