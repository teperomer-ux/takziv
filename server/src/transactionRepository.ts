import { Timestamp, type DocumentReference } from "firebase-admin/firestore";
import type { UserMapping } from "../../src/utils/classifier.js";
import { adminDb } from "./firebaseAdmin.js";
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
 * Inserts rows that don't exist yet into users/{uid}/{collection}.
 * Existing docs (same deterministic id) are left untouched so a re-sync never
 * overwrites categories the user already edited. Returns the number inserted.
 */
export async function saveNewTransactions(
  userId: string,
  collection: TargetCollection,
  txs: MappedTransaction[],
): Promise<number> {
  const col = adminDb.collection("users").doc(userId).collection(collection);
  let inserted = 0;

  for (let i = 0; i < txs.length; i += BATCH_LIMIT) {
    const chunk = txs.slice(i, i + BATCH_LIMIT);
    const refs: DocumentReference[] = chunk.map((tx) => col.doc(tx.id));
    const existing = await adminDb.getAll(...refs);

    const batch = adminDb.batch();
    let pending = 0;
    chunk.forEach((tx, idx) => {
      if (existing[idx].exists) return;
      batch.create(refs[idx], {
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
      pending++;
    });

    if (pending > 0) await batch.commit();
    inserted += pending;
  }

  return inserted;
}
