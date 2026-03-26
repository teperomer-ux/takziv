import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  onSnapshot,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { CATEGORIES } from "../constants/categories";

const COLLECTION = "categories";
const colRef = collection(db, COLLECTION);

export interface CategoryDoc {
  name: string;
  subCategories: string[];
}

/**
 * Fetch all categories from Firestore (one-shot).
 * Returns a Record<string, string[]> matching the shape of the static CATEGORIES.
 */
export async function getCategories(): Promise<Record<string, string[]>> {
  const snapshot = await getDocs(colRef);
  if (snapshot.empty) return {};
  const result: Record<string, string[]> = {};
  for (const d of snapshot.docs) {
    const data = d.data();
    result[d.id] = Array.isArray(data.subCategories) ? data.subCategories : [];
  }
  return result;
}

/**
 * Subscribe to category changes in real-time.
 * Returns an unsubscribe function.
 */
export function onCategoriesSnapshot(
  callback: (cats: Record<string, string[]>) => void,
  onError?: (err: Error) => void
): () => void {
  return onSnapshot(
    colRef,
    (snapshot) => {
      const result: Record<string, string[]> = {};
      for (const d of snapshot.docs) {
        const data = d.data();
        result[d.id] = Array.isArray(data.subCategories) ? data.subCategories : [];
      }
      callback(result);
    },
    onError
  );
}

/**
 * Add a new main category (סעיף).
 * Uses the category name as the document ID for easy lookup.
 */
export async function addCategory(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await setDoc(doc(db, COLLECTION, trimmed), {
    name: trimmed,
    subCategories: [],
  });
}

/**
 * Add a new sub-category (תת סעיף) to an existing category.
 * Uses arrayUnion to prevent duplicates.
 */
export async function addSubCategory(
  categoryName: string,
  subCategoryName: string
): Promise<void> {
  const catTrimmed = categoryName.trim();
  const subTrimmed = subCategoryName.trim();
  if (!catTrimmed || !subTrimmed) return;

  const ref = doc(db, COLLECTION, catTrimmed);
  await updateDoc(ref, {
    subCategories: arrayUnion(subTrimmed),
  });
}

/** Delete an entire category. */
export async function deleteCategory(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await deleteDoc(doc(db, COLLECTION, trimmed));
}

/** Remove a sub-category from a category. */
export async function removeSubCategory(
  categoryName: string,
  subCategoryName: string
): Promise<void> {
  const catTrimmed = categoryName.trim();
  const subTrimmed = subCategoryName.trim();
  if (!catTrimmed || !subTrimmed) return;
  const ref = doc(db, COLLECTION, catTrimmed);
  await updateDoc(ref, {
    subCategories: arrayRemove(subTrimmed),
  });
}

/** Rename a category by creating a new doc and deleting the old one. */
export async function renameCategory(
  oldName: string,
  newName: string,
  subCategories: string[]
): Promise<void> {
  const oldTrimmed = oldName.trim();
  const newTrimmed = newName.trim();
  if (!oldTrimmed || !newTrimmed || oldTrimmed === newTrimmed) return;
  await setDoc(doc(db, COLLECTION, newTrimmed), {
    name: newTrimmed,
    subCategories,
  });
  await deleteDoc(doc(db, COLLECTION, oldTrimmed));
}

/**
 * Seed Firestore with the static categories from constants/categories.ts.
 * Only writes categories that don't already exist in Firestore.
 * Call this once at app startup.
 */
export async function seedCategories(): Promise<void> {
  const existing = await getCategories();
  const promises: Promise<void>[] = [];

  for (const [name, subs] of Object.entries(CATEGORIES)) {
    if (!(name in existing)) {
      promises.push(
        setDoc(doc(db, COLLECTION, name), {
          name,
          subCategories: subs,
        })
      );
    }
  }

  if (promises.length > 0) {
    await Promise.all(promises);
    console.info(`[categoryService] seeded ${promises.length} categories`);
  }
}
