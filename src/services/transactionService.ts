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

const COLLECTION = "transactions";
const NOOP = () => {};

/** Return the user-scoped collection: users/{uid}/transactions */
function userCol() {
  return collection(db, "users", getUid(), COLLECTION);
}

/** Return a user-scoped document ref: users/{uid}/transactions/{docId} */
function userDoc(docId: string) {
  return doc(db, "users", getUid(), COLLECTION, docId);
}

// ─── Converters ─────────────────────────────────────────────────────────────

/** Derive billingMonth/billingYear from the date if not explicitly set. */
function deriveBilling(tx: { date: string; billingMonth?: number; billingYear?: number }) {
  if (tx.billingMonth && tx.billingYear) return { billingMonth: tx.billingMonth, billingYear: tx.billingYear };
  // Fallback: parse from date string "YYYY-MM-DD"
  const [y, m] = tx.date.split("-").map(Number);
  return { billingMonth: m || 1, billingYear: y || new Date().getFullYear() };
}

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
  const parsed = new Date(tx.date);
  // Guard against Invalid Date — fall back to today rather than crashing the batch
  const safeDate = isNaN(parsed.getTime()) ? new Date() : parsed;
  const billing = deriveBilling(tx);
  return {
    date: Timestamp.fromDate(safeDate),
    description: tx.description,
    amount: tx.amount,
    category: tx.category ?? "",
    subCategory: tx.subCategory ?? "",
    status: tx.status,
    billingMonth: billing.billingMonth,
    billingYear: billing.billingYear,
  };
}

// ─── Write operations ───────────────────────────────────────────────────────

/** Add a single transaction. Returns the generated doc ID. */
export async function addTransaction(
  tx: Omit<Transaction, "id">
): Promise<string> {
  const ref = await addDoc(userCol(), toFirestoreData(tx));
  return ref.id;
}

/** Bulk-save transactions in atomic batch writes (auto-chunks at 500). */
export async function bulkSaveTransactions(
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

/** Update specific fields on an existing transaction. */
export async function updateTransaction(
  id: string,
  data: Partial<Omit<Transaction, "id">>
): Promise<void> {
  const ref = userDoc(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { ...data };
  if (data.date) {
    const parsed = new Date(data.date);
    updates.date = Timestamp.fromDate(isNaN(parsed.getTime()) ? new Date() : parsed);
  }
  await updateDoc(ref, updates);
}

/** Delete a transaction by ID. */
export async function deleteTransaction(id: string): Promise<void> {
  await deleteDoc(userDoc(id));
}

/**
 * Delete all transactions for a given billing month (batch).
 *
 * Strategy: fetch EVERY doc, convert with docToTransaction (which applies the
 * billingMonth/billingYear fallback for legacy docs missing those fields),
 * then delete the ones that match.  This guarantees we catch documents whose
 * billingMonth was never written to Firestore but is derived from the date.
 */
export async function deleteMonthTransactions(
  year: number,
  month: number,
): Promise<number> {
  console.log(`🔥 DELETE START: billingMonth=${month}, billingYear=${year}`);

  const colRef = userCol();

  // 1. Fetch every document in the collection
  const allSnapshot = await getDocs(query(colRef, orderBy("date", "desc")));

  if (allSnapshot.empty) {
    console.log("🔥 DELETE: collection is empty, nothing to delete");
    return 0;
  }

  // 2. Convert to Transaction objects (applies billingMonth fallback)
  //    and collect refs whose billingMonth/billingYear match
  const refsToDelete: ReturnType<typeof doc>[] = [];

  for (const d of allSnapshot.docs) {
    const tx = docToTransaction(d.id, d.data());
    if (tx.billingMonth === month && tx.billingYear === year) {
      refsToDelete.push(d.ref);
    }
  }

  console.log(`🔥 DELETE: found ${refsToDelete.length} docs matching ${year}-${String(month).padStart(2, "0")} out of ${allSnapshot.size} total`);

  if (refsToDelete.length === 0) return 0;

  // 3. Batch-delete in chunks of 500
  for (let i = 0; i < refsToDelete.length; i += 500) {
    const chunk = refsToDelete.slice(i, i + 500);
    const batch = writeBatch(db);
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
  }

  console.log(`🔥 FIRESTORE DELETED: ${refsToDelete.length} documents for ${month}/${year}`);

  // 4. Verify: re-fetch and confirm the bucket is empty
  const verifySnapshot = await getDocs(query(colRef, orderBy("date", "desc")));
  const remaining = verifySnapshot.docs
    .map((d) => docToTransaction(d.id, d.data()))
    .filter((tx) => tx.billingMonth === month && tx.billingYear === year);

  if (remaining.length > 0) {
    console.error(`🔥 VERIFY FAILED: ${remaining.length} docs STILL match ${month}/${year} after deletion!`);
  } else {
    console.log(`🔥 VERIFY OK: 0 docs remain for ${month}/${year}`);
  }

  return refsToDelete.length;
}

// ─── Read operations ────────────────────────────────────────────────────────

/** Fetch every transaction in the collection (one-shot). */
export async function getAllTransactions(): Promise<Transaction[]> {
  if (!getUidOrNull()) return [];
  const q = query(userCol(), orderBy("date", "desc"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => docToTransaction(d.id, d.data()));
}

/** Fetch all transactions for a given billing month (one-shot). */
export async function getTransactionsByMonth(
  year: number,
  month: number
): Promise<Transaction[]> {
  const q = query(
    userCol(),
    where("billingYear", "==", year),
    where("billingMonth", "==", month),
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
  if (!getUidOrNull()) { callback([]); return NOOP; }
  const q = query(
    userCol(),
    where("billingYear", "==", year),
    where("billingMonth", "==", month),
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
