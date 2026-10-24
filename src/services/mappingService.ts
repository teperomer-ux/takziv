import {
  collection,
  doc,
  getDocs,
  writeBatch,
  query,
  where,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { descriptionKey, ruleMatches } from "../utils/descriptionKey";

const COLLECTION = "learnedMappings";

export interface LearnedMapping {
  description: string;
  category: string;
  subCategory: string;
}

/** Return the user-scoped collection ref: users/{uid}/{collectionName} */
function userCol(userId: string, colName: string = COLLECTION) {
  return collection(db, "users", userId, colName);
}

/** Sanitise a string into a safe Firestore document ID. */
function sanitizeId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[/\\.\s]+/g, "_")   // chars illegal in doc IDs → underscore
    .replace(/_{2,}/g, "_")        // collapse runs
    .slice(0, 120);                // Firestore IDs ≤ 1500 bytes; 120 chars is safe
}

/**
 * Document ID for a description's mapping. Keyed by the normalised
 * description so "משכורת 09/26" and "משכורת 10/26" share one rule; a
 * description with no words left keeps its raw sanitised form.
 */
function toDocId(description: string): string {
  return sanitizeId(descriptionKey(description)) || sanitizeId(description);
}

/**
 * Save (or update) a single learned mapping for a specific user.
 * Uses the normalised description as the document ID → upsert semantics.
 * A rule saved under the older raw-description ID is removed so the two
 * can't disagree.
 */
export async function saveMapping(
  userId: string,
  description: string,
  category: string,
  subCategory: string,
  colName: string = COLLECTION
): Promise<void> {
  const id = toDocId(description);
  if (!id) return;
  const batch = writeBatch(db);
  batch.set(doc(db, "users", userId, colName, id), {
    description: description.trim(),
    category,
    subCategory,
  });
  const legacyId = sanitizeId(description);
  if (legacyId && legacyId !== id) batch.delete(doc(db, "users", userId, colName, legacyId));
  await batch.commit();
}

/**
 * Applies a just-learned rule to the user's existing rows that still have no
 * category (any month), so earlier imports benefit too — not only future
 * syncs. Rows that are already categorised are never touched. Returns how
 * many rows were updated.
 */
export async function applyMappingToUncategorized(
  userId: string,
  txCollection: "transactions" | "incomeTransactions",
  description: string,
  category: string,
  subCategory: string,
  excludeId?: string,
): Promise<number> {
  if (!category) return 0;
  const snapshot = await getDocs(
    query(collection(db, "users", userId, txCollection), where("category", "==", "")),
  );
  const refs = snapshot.docs
    .filter((d) => d.id !== excludeId && ruleMatches(description, String(d.data().description ?? "")))
    .map((d) => d.ref);

  for (let i = 0; i < refs.length; i += 500) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(i, i + 500)) batch.update(ref, { category, subCategory });
    await batch.commit();
  }
  return refs.length;
}

/**
 * Bulk-save mappings in batched writes (max 500 per batch).
 * Skips rows with empty category. All writes scoped to the given user.
 */
export async function bulkSaveMappings(
  userId: string,
  items: { description: string; category: string; subCategory: string }[],
  colName: string = COLLECTION
): Promise<void> {
  const valid = items.filter((i) => i.category && toDocId(i.description));
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500);
    const batch = writeBatch(db);
    for (const item of chunk) {
      const ref = doc(db, "users", userId, colName, toDocId(item.description));
      batch.set(ref, {
        description: item.description.trim(),
        category: item.category,
        subCategory: item.subCategory,
      });
    }
    await batch.commit();
  }
}

/** Fetch all learned mappings for a specific user (one-shot). */
export async function getLearnedMappings(userId: string, colName: string = COLLECTION): Promise<LearnedMapping[]> {
  const snapshot = await getDocs(userCol(userId, colName));
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      description: (data.description as string) ?? "",
      category: (data.category as string) ?? "",
      subCategory: (data.subCategory as string) ?? "",
    };
  });
}

/** Clear ALL learned mappings for a specific user (batch-delete in chunks of 500). */
export async function clearAllMappings(userId: string, colName: string = COLLECTION): Promise<void> {
  const snapshot = await getDocs(userCol(userId, colName));
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const chunk = snapshot.docs.slice(i, i + 500);
    const batch = writeBatch(db);
    for (const d of chunk) batch.delete(d.ref);
    await batch.commit();
  }
}
