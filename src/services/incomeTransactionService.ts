import {
  collection,
  getDocs,
  updateDoc,
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
import { israelYmd } from "../utils/formatDate";
import { deleteAndDismiss } from "./dismissedTransactionService";

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
  const dateStr = israelYmd(ts?.toDate?.() ?? new Date());
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

// ─── Write operations ───────────────────────────────────────────────────────

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
  // Tombstoned so bank sync won't re-import the deleted credit.
  await deleteAndDismiss(COLLECTION, id);
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

// ─── Session history cache ──────────────────────────────────────────────────
// The savings profile needs every month's income. Read once per session and
// again only after a bank sync (the month on screen comes from its listener).

let incomeHistory: { uid: string; fetchedAt: number; promise: Promise<Transaction[]> } | null = null;

/** Every income of the signed-in user; cached unless a bank sync finished after the last read. */
export async function loadIncomeHistory(importedAt = 0): Promise<Transaction[]> {
  const uid = getUidOrNull();
  if (!uid) return [];
  if (!incomeHistory || incomeHistory.uid !== uid || importedAt > incomeHistory.fetchedAt) {
    const promise = getDocs(userCol()).then((snapshot) => snapshot.docs.map((d) => docToTransaction(d.id, d.data())));
    incomeHistory = { uid, fetchedAt: Date.now(), promise };
    promise.catch(() => {
      if (incomeHistory?.promise === promise) incomeHistory = null;
    });
  }
  return incomeHistory.promise;
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
