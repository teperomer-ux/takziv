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
const colRef = collection(db, COLLECTION);

export interface LearnedMapping {
  description: string;
  category: string;
  subCategory: string;
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
 * Save (or update) a single learned mapping.
 * Uses the sanitised description as the document ID → upsert semantics.
 */
export async function saveMapping(
  description: string,
  category: string,
  subCategory: string
): Promise<void> {
  const id = toDocId(description);
  if (!id) return;
  await setDoc(doc(db, COLLECTION, id), {
    description: description.trim(),
    category,
    subCategory,
  });
}

/**
 * Bulk-save mappings in batched writes (max 500 per batch).
 * Skips rows with empty category.
 */
export async function bulkSaveMappings(
  items: { description: string; category: string; subCategory: string }[]
): Promise<void> {
  const valid = items.filter((i) => i.category && toDocId(i.description));
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500);
    const batch = writeBatch(db);
    for (const item of chunk) {
      const ref = doc(db, COLLECTION, toDocId(item.description));
      batch.set(ref, {
        description: item.description.trim(),
        category: item.category,
        subCategory: item.subCategory,
      });
    }
    await batch.commit();
  }
}

/** Fetch all learned mappings (one-shot). */
export async function getLearnedMappings(): Promise<LearnedMapping[]> {
  const snapshot = await getDocs(colRef);
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      description: (data.description as string) ?? "",
      category: (data.category as string) ?? "",
      subCategory: (data.subCategory as string) ?? "",
    };
  });
}

/** Delete a single learned mapping by description. */
export async function deleteMapping(description: string): Promise<void> {
  const id = toDocId(description);
  if (!id) return;
  await deleteDoc(doc(db, COLLECTION, id));
}

/** Clear ALL learned mappings (batch-delete in chunks of 500). */
export async function clearAllMappings(): Promise<void> {
  const snapshot = await getDocs(colRef);
  for (let i = 0; i < snapshot.docs.length; i += 500) {
    const chunk = snapshot.docs.slice(i, i + 500);
    const batch = writeBatch(db);
    for (const d of chunk) batch.delete(d.ref);
    await batch.commit();
  }
}
