export type TransactionStatus = "draft" | "confirmed";

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
}
