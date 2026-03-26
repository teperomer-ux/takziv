import { useState, useEffect, useCallback } from "react";
import {
  onTransactionsSnapshot,
  updateTransaction,
  deleteTransaction,
  deleteMonthTransactions,
} from "../services/transactionService";
import type { Transaction } from "../types";

interface UseTransactionsReturn {
  transactions: Transaction[];
  loading: boolean;
  error: string | null;
  update: (id: string, field: keyof Omit<Transaction, "id">, value: string | number) => void;
  remove: (id: string) => void;
  removeAll: () => Promise<number>;
  setMonth: (year: number, month: number) => void;
  year: number;
  month: number;
}

export function useTransactions(): UseTransactionsReturn {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonthNum] = useState(now.getMonth() + 1);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Real-time subscription — re-subscribes when year/month changes
  useEffect(() => {
    setLoading(true);
    setError(null);

    const unsubscribe = onTransactionsSnapshot(
      year,
      month,
      (txs) => {
        setTransactions(txs);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [year, month]);

  const update = useCallback(
    (id: string, field: keyof Omit<Transaction, "id">, value: string | number) => {
      // Optimistic local update
      setTransactions((prev) =>
        prev.map((tx) => (tx.id === id ? { ...tx, [field]: value } : tx))
      );
      // Persist — snapshot listener will reconcile if it differs
      updateTransaction(id, { [field]: value } as Partial<Omit<Transaction, "id">>).catch(
        (err) => {
          console.error("[useTransactions] update failed:", err);
          setError("שגיאה בעדכון העסקה");
        }
      );
    },
    []
  );

  const remove = useCallback((id: string) => {
    setTransactions((prev) => prev.filter((tx) => tx.id !== id));
    deleteTransaction(id).catch((err) => {
      console.error("[useTransactions] delete failed:", err);
      setError("שגיאה במחיקת העסקה");
    });
  }, []);

  const removeAll = useCallback(async () => {
    const count = await deleteMonthTransactions(year, month);
    // Optimistic: the snapshot listener will also clear, but clear immediately
    setTransactions([]);
    return count;
  }, [year, month]);

  const setMonth = useCallback((y: number, m: number) => {
    setYear(y);
    setMonthNum(m);
  }, []);

  return { transactions, loading, error, update, remove, removeAll, setMonth, year, month };
}
