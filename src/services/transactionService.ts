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
import { deleteAndDismiss } from "./dismissedTransactionService";
import { israelYmd } from "../utils/formatDate";

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

/** Accept only the four canonical source slugs; anything else (incl. the
 *  legacy "credit-card" string written before provider-level tagging) maps to
 *  undefined so the rest of the app treats those rows as untagged CC. */
const VALID_SOURCES: ReadonlySet<NonNullable<Transaction["source"]>> = new Set([
  "max",
  "isracard",
  "cal",
  "bank",
]);
function normalizeSource(raw: unknown): Transaction["source"] {
  if (typeof raw !== "string") return undefined;
  return VALID_SOURCES.has(raw as NonNullable<Transaction["source"]>)
    ? (raw as Transaction["source"])
    : undefined;
}

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
    source: normalizeSource(data.source),
  };
}

// ─── Write operations ───────────────────────────────────────────────────────

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

/** Delete a transaction by ID; bank sync won't re-import it. */
export async function deleteTransaction(id: string): Promise<void> {
  await deleteAndDismiss(COLLECTION, id);
}

/**
 * Delete all transactions for a given billing month (batch). Queries the
 * month directly — the same filter the month view's listener uses, so it
 * deletes exactly the rows the user sees — and reads only those docs.
 */
export async function deleteMonthTransactions(
  year: number,
  month: number,
): Promise<number> {
  const snapshot = await getDocs(
    query(userCol(), where("billingYear", "==", year), where("billingMonth", "==", month)),
  );
  if (snapshot.empty) return 0;

  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const batch = writeBatch(db);
    for (const d of snapshot.docs.slice(i, i + 500)) batch.delete(d.ref);
    await batch.commit();
  }
  return snapshot.docs.length;
}

// ─── Read operations ────────────────────────────────────────────────────────

// ─── Session history cache ──────────────────────────────────────────────────
//
// The dashboard's averages, trend and recurring-bill views need every month,
// but reading the whole collection costs one Firestore read per row. It is
// read once per session and kept here (surviving tab switches); the month on
// screen is kept current from its live listener via mergeMonthIntoHistory, so
// edits and deletes cost no extra reads. The full read is repeated only after
// a bank sync, which can add rows to any month.

interface History {
  uid: string;
  /** Date.now() when the read started; a sync finishing after it makes the cache stale. */
  fetchedAt: number;
  rows: Map<string, Transaction>;
  /**
   * Rows stored without billingYear/billingMonth. The month listener can't
   * see them (it filters on those fields), so a month merge must not treat
   * their absence from it as a delete.
   */
  legacyIds: Set<string>;
}

let history: { uid: string; fetchedAt: number; promise: Promise<History> } | null = null;
let loaded: History | null = null;

/**
 * Every transaction of the signed-in user, from the session cache when it is
 * newer than `importedAt` (ms of the latest bank sync), otherwise from one
 * full read.
 */
export async function loadTransactionHistory(importedAt = 0): Promise<Transaction[]> {
  const uid = getUidOrNull();
  if (!uid) return [];
  if (!history || history.uid !== uid || importedAt > history.fetchedAt) {
    const fetchedAt = Date.now();
    const promise = getDocs(query(userCol(), orderBy("date", "desc"))).then((snapshot) => {
      const h: History = { uid, fetchedAt, rows: new Map(), legacyIds: new Set() };
      for (const d of snapshot.docs) {
        const data = d.data();
        h.rows.set(d.id, docToTransaction(d.id, data));
        if (data.billingYear == null || data.billingMonth == null) h.legacyIds.add(d.id);
      }
      if (history?.promise === promise) loaded = h;
      return h;
    });
    history = { uid, fetchedAt, promise };
    promise.catch(() => {
      if (history?.promise === promise) history = null;
    });
  }
  return [...(await history.promise).rows.values()];
}

/**
 * Replaces one billing month of the cached history with the rows its live
 * listener reported (`live` must be that month's complete result), and
 * returns the updated history; null while it hasn't loaded. Idempotent.
 */
export function mergeMonthIntoHistory(year: number, month: number, live: readonly Transaction[]): Transaction[] | null {
  const h = loaded;
  if (!h || h.uid !== getUidOrNull()) return null;
  const liveIds = new Set<string>();
  for (const tx of live) {
    if (tx.billingYear !== year || tx.billingMonth !== month) continue;
    liveIds.add(tx.id);
    h.rows.set(tx.id, tx);
    h.legacyIds.delete(tx.id);
  }
  for (const [id, tx] of h.rows) {
    if (tx.billingYear === year && tx.billingMonth === month && !liveIds.has(id) && !h.legacyIds.has(id)) {
      h.rows.delete(id);
    }
  }
  return [...h.rows.values()];
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
