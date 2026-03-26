import {
  collection,
  addDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  writeBatch,
  doc,
  onSnapshot,
  Timestamp,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import type { Transaction } from "../types";

const COLLECTION = "transactions";
const colRef = collection(db, COLLECTION);

// ─── Converters ─────────────────────────────────────────────────────────────

function docToTransaction(
  id: string,
  data: Record<string, unknown>
): Transaction {
  const ts = data.date as Timestamp;
  return {
    id,
    date: ts.toDate().toISOString().split("T")[0],
    description: (data.description as string) ?? "",
    amount: (data.amount as number) ?? 0,
    category: (data.category as string) ?? "",
    subCategory: (data.subCategory as string) ?? "",
    status: (data.status as Transaction["status"]) ?? "draft",
  };
}

function toFirestoreData(tx: Omit<Transaction, "id">) {
  return {
    date: Timestamp.fromDate(new Date(tx.date)),
    description: tx.description,
    amount: tx.amount,
    category: tx.category,
    subCategory: tx.subCategory,
    status: tx.status,
  };
}

// ─── Write operations ───────────────────────────────────────────────────────

/** Add a single transaction. Returns the generated doc ID. */
export async function addTransaction(
  tx: Omit<Transaction, "id">
): Promise<string> {
  const ref = await addDoc(colRef, toFirestoreData(tx));
  return ref.id;
}

/** Bulk-save transactions in atomic batch writes (auto-chunks at 500). */
export async function bulkSaveTransactions(
  txs: Omit<Transaction, "id">[]
): Promise<void> {
  for (let i = 0; i < txs.length; i += 500) {
    const chunk = txs.slice(i, i + 500);
    const batch = writeBatch(db);
    for (const tx of chunk) {
      const ref = doc(colRef);
      batch.set(ref, toFirestoreData(tx));
    }
    await batch.commit();
  }
}

/** Update specific fields on an existing transaction. */
export async function updateTransaction(
  id: string,
  data: Partial<Omit<Transaction, "id">>
): Promise<void> {
  const ref = doc(db, COLLECTION, id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { ...data };
  if (data.date) {
    updates.date = Timestamp.fromDate(new Date(data.date));
  }
  await updateDoc(ref, updates);
}

/** Delete a transaction by ID. */
export async function deleteTransaction(id: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTION, id));
}

/** Delete all transactions for a given month (batch). */
export async function deleteMonthTransactions(
  year: number,
  month: number
): Promise<number> {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  const q = query(
    colRef,
    where("date", ">=", Timestamp.fromDate(start)),
    where("date", "<", Timestamp.fromDate(end))
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return 0;

  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const chunk = snapshot.docs.slice(i, i + 500);
    const batch = writeBatch(db);
    for (const d of chunk) batch.delete(d.ref);
    await batch.commit();
  }

  return snapshot.docs.length;
}

// ─── Read operations ────────────────────────────────────────────────────────

/** Fetch every transaction in the collection (one-shot). */
export async function getAllTransactions(): Promise<Transaction[]> {
  const q = query(colRef, orderBy("date", "desc"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => docToTransaction(d.id, d.data()));
}

/** Fetch all transactions for a given month (one-shot). */
export async function getTransactionsByMonth(
  year: number,
  month: number
): Promise<Transaction[]> {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  const q = query(
    colRef,
    where("date", ">=", Timestamp.fromDate(start)),
    where("date", "<", Timestamp.fromDate(end)),
    orderBy("date", "desc")
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => docToTransaction(d.id, d.data()));
}

// ─── Real-time listener ─────────────────────────────────────────────────────

/**
 * Subscribe to all transactions for a given month.
 * Firestore pushes changes in real-time — the callback fires on every update.
 * Returns an unsubscribe function.
 */
export function onTransactionsSnapshot(
  year: number,
  month: number,
  callback: (txs: Transaction[]) => void,
  onError?: (err: Error) => void
): () => void {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  const q = query(
    colRef,
    where("date", ">=", Timestamp.fromDate(start)),
    where("date", "<", Timestamp.fromDate(end)),
    orderBy("date", "desc")
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const txs = snapshot.docs.map((d) => docToTransaction(d.id, d.data()));
      callback(txs);
    },
    (err) => {
      console.error("[transactionService] snapshot error:", err);
      onError?.(err);
    }
  );
}
