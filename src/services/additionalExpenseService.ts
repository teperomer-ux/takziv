import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "../lib/firebase";

const COLLECTION = "additionalExpenses";
const colRef = collection(db, COLLECTION);

export type ExpenseKind = "recurring" | "one-time";

export interface AdditionalExpense {
  id: string;
  description: string;
  amount: number;
  category: string;
  kind: ExpenseKind;
  /** For one-time: the specific month (YYYY-MM). For recurring: the start month. */
  monthKey: string;
}

/** Subscribe to all additional expenses in real-time. */
export function onAdditionalExpensesSnapshot(
  callback: (expenses: AdditionalExpense[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(colRef, orderBy("monthKey", "desc"));
  return onSnapshot(
    q,
    (snapshot) => {
      callback(
        snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as AdditionalExpense),
      );
    },
    onError,
  );
}

/** Add or update an additional expense entry. */
export async function saveAdditionalExpense(
  expense: Omit<AdditionalExpense, "id"> & { id?: string },
): Promise<string> {
  const id = expense.id ?? doc(colRef).id;
  await setDoc(doc(db, COLLECTION, id), {
    description: expense.description,
    amount: expense.amount,
    category: expense.category,
    kind: expense.kind,
    monthKey: expense.monthKey,
  });
  return id;
}

/** Delete an additional expense entry. */
export async function deleteAdditionalExpense(id: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTION, id));
}

/**
 * Compute the total additional expenses for a specific month.
 *  - One-time expenses: only if monthKey matches exactly.
 *  - Recurring expenses: if monthKey <= target month (started on or before).
 */
export function expenseTotalForMonth(
  expenses: AdditionalExpense[],
  year: number,
  month: number,
): number {
  const target = `${year}-${String(month).padStart(2, "0")}`;
  let total = 0;
  for (const exp of expenses) {
    if (exp.kind === "one-time") {
      if (exp.monthKey === target) total += exp.amount;
    } else {
      // recurring: active from its start month onward
      if (exp.monthKey <= target) total += exp.amount;
    }
  }
  return total;
}
