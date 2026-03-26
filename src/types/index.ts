export type TransactionStatus = "draft" | "confirmed";

export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  description: string; // בית עסק / תיאור
  amount: number;
  category: string; // סעיף
  subCategory: string; // תת סעיף
  status: TransactionStatus;
}
