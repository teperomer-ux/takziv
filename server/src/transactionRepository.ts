import { Timestamp, type CollectionReference } from "firebase-admin/firestore";
import type { UserMapping } from "../../src/utils/classifier.js";
import { adminDb } from "./firebaseAdmin.js";
import { findContentDuplicates, type ExistingRow } from "./dedupe.js";
import type { MappedTransaction, UserMappings } from "./transactionMapper.js";

const BATCH_LIMIT = 500;

export type TargetCollection = "transactions" | "incomeTransactions";

async function readMappings(userId: string, collection: string): Promise<UserMapping[]> {
  const snapshot = await adminDb.collection("users").doc(userId).collection(collection).get();
  return snapshot.docs
    .map((d) => {
      const data = d.data();
      return {
        description: String(data.description ?? ""),
        category: String(data.category ?? ""),
        subCategory: String(data.subCategory ?? ""),
      };
    })
    .filter((m) => m.description);
}

/** The user's learned description → category mappings for expenses and incomes. */
export async function getUserMappings(userId: string): Promise<UserMappings> {
  const [expense, income] = await Promise.all([
    readMappings(userId, "learnedMappings"),
    readMappings(userId, "learnedIncomeMappings"),
  ]);
  return { expense, income };
}

/**
 * Inserts rows that don't exist yet into users/{uid}/{collection}, skipping
 *  - rows whose deterministic id already exists (an earlier sync), and
 *  - rows matching an existing doc by date + amount + business name (e.g. an
 *    earlier CSV upload, which used random ids) — see findContentDuplicates.
 * Existing docs are never touched, so a re-sync can't overwrite categories
 * the user already edited.
 */
export async function saveNewTransactions(
  userId: string,
  collection: TargetCollection,
  txs: MappedTransaction[],
): Promise<SaveResult> {
  const col = adminDb.collection("users").doc(userId).collection(collection);

  const missing: MappedTransaction[] = [];
  for (let i = 0; i < txs.length; i += BATCH_LIMIT) {
    const chunk = txs.slice(i, i + BATCH_LIMIT);
    const snaps = await adminDb.getAll(...chunk.map((tx) => col.doc(tx.id)));
    chunk.forEach((tx, idx) => {
      if (!snaps[idx].exists) missing.push(tx);
    });
  }

  let contentDuplicates = new Set<string>();
  if (missing.length) {
    const scrapedIds = new Set(txs.map((tx) => tx.id));
    const existing = (await readRowsInRange(col, missing)).filter((row) => !scrapedIds.has(row.id));
    contentDuplicates = findContentDuplicates(missing, existing);
  }
  const toInsert = missing.filter((tx) => !contentDuplicates.has(tx.id));

  for (let i = 0; i < toInsert.length; i += BATCH_LIMIT) {
    const batch = adminDb.batch();
    for (const tx of toInsert.slice(i, i + BATCH_LIMIT)) {
      batch.create(col.doc(tx.id), {
        // Stored as UTC midnight, matching the client's Timestamp.fromDate(new Date("YYYY-MM-DD")).
        date: Timestamp.fromDate(new Date(`${tx.date}T00:00:00Z`)),
        description: tx.description,
        amount: tx.amount,
        category: tx.category,
        subCategory: tx.subCategory,
        // Auto-imported rows start as drafts so the user reviews the categories.
        status: "draft",
        billingMonth: tx.billingMonth,
        billingYear: tx.billingYear,
        ...(tx.source && { source: tx.source }),
        userId,
        importedFrom: "bank-sync",
        importedAt: Timestamp.now(),
      });
    }
    await batch.commit();
  }

  return {
    inserted: toInsert.length,
    duplicateById: txs.length - missing.length,
    duplicateByContent: contentDuplicates.size,
  };
}

export interface SaveResult {
  inserted: number;
  /** Already saved by an earlier sync (same deterministic id). */
  duplicateById: number;
  /** Already present under another id, e.g. from a CSV upload. */
  duplicateByContent: number;
}

/** Existing docs dated within the span of `txs` (dates are stored as UTC midnight). */
async function readRowsInRange(col: CollectionReference, txs: MappedTransaction[]): Promise<ExistingRow[]> {
  const dates = txs.map((tx) => tx.date).sort();
  const snapshot = await col
    .where("date", ">=", Timestamp.fromDate(new Date(`${dates[0]}T00:00:00Z`)))
    .where("date", "<=", Timestamp.fromDate(new Date(`${dates[dates.length - 1]}T00:00:00Z`)))
    .get();
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      date: (data.date as Timestamp).toDate().toISOString().slice(0, 10),
      amount: Number(data.amount ?? 0),
      description: String(data.description ?? ""),
      source: typeof data.source === "string" ? data.source : undefined,
    };
  });
}
