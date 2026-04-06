import {
  collection,
  doc,
  getDocs,
  writeBatch,
  setDoc,
  deleteDoc,
} from "firebase/firestore";
import { db } from "../lib/firebase";

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

/** Sanitise a description into a safe Firestore document ID. */
function toDocId(description: string): string {
  return description
    .trim()
    .toLowerCase()
    .replace(/[/\\.\s]+/g, "_")   // chars illegal in doc IDs → underscore
    .replace(/_{2,}/g, "_")        // collapse runs
    .slice(0, 120);                // Firestore IDs ≤ 1500 bytes; 120 chars is safe
}

/**
 * Save (or update) a single learned mapping for a specific user.
 * Uses the sanitised description as the document ID → upsert semantics.
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
  await setDoc(doc(db, "users", userId, colName, id), {
    description: description.trim(),
    category,
    subCategory,
  });
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

/** Delete a single learned mapping by description for a specific user. */
export async function deleteMapping(userId: string, description: string, colName: string = COLLECTION): Promise<void> {
  const id = toDocId(description);
  if (!id) return;
  await deleteDoc(doc(db, "users", userId, colName, id));
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
