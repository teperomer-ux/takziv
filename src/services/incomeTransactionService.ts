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
import { db, getUid, getUidOrNull } from "../lib/firebase";
import type { Transaction } from "../types";

const COLLECTION = "incomeTransactions";
const NOOP = () => {};

function userCol() {
  return collection(db, "users", getUid(), COLLECTION);
}

function userDoc(docId: string) {
  return doc(db, "users", getUid(), COLLECTION, docId);
}

// ─── Converters ─────────────────────────────────────────────────────────────

function docToTransaction(
  id: string,
  data: Record<string, unknown>
): Transaction {
  const ts = data.date as Timestamp;
  const dateStr = ts?.toDate?.().toISOString().split("T")[0] ?? new Date().toISOString().split("T")[0];
  const [fallbackY, fallbackM] = dateStr.split("-").map(Number);
  return {
    id,
    date: dateStr,
    description: (data.description as string) ?? "",
    amount: (data.amount as number) ?? 0,
    category: (data.category as string) ?? "",
    subCategory: (data.subCategory as string) ?? "",
    status: (data.status as Transaction["status"]) ?? "draft",
    billingMonth: (data.billingMonth as number) ?? fallbackM,
    billingYear: (data.billingYear as number) ?? fallbackY,
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

export async function addIncomeTransaction(
  tx: Omit<Transaction, "id">
): Promise<string> {
  const ref = await addDoc(userCol(), toFirestoreData(tx));
  return ref.id;
}

export async function bulkSaveIncomeTransactions(
  txs: Omit<Transaction, "id">[]
): Promise<void> {
  const colRef = userCol();
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

export async function updateIncomeTransaction(
  id: string,
  data: Partial<Omit<Transaction, "id">>
): Promise<void> {
  const ref = userDoc(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { ...data };
  if (data.date) {
    updates.date = Timestamp.fromDate(new Date(data.date));
  }
  await updateDoc(ref, updates);
}

export async function deleteIncomeTransaction(id: string): Promise<void> {
  await deleteDoc(userDoc(id));
}

export async function deleteMonthIncomeTransactions(
  year: number,
  month: number
): Promise<number> {
  const colRef = userCol();
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

export async function getAllIncomeTransactions(): Promise<Transaction[]> {
  if (!getUidOrNull()) return [];
  const q = query(userCol(), orderBy("date", "desc"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => docToTransaction(d.id, d.data()));
}

// ─── Real-time listener ─────────────────────────────────────────────────────

export function onIncomeTransactionsSnapshot(
  year: number,
  month: number,
  callback: (txs: Transaction[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!getUidOrNull()) { callback([]); return NOOP; }
  const colRef = userCol();
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
      console.error("[incomeTransactionService] snapshot error:", err);
      onError?.(err);
    }
  );
}
