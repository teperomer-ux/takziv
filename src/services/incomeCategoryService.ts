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
import { INCOME_CATEGORIES } from "../constants/incomeCategories";

const COLLECTION = "incomeCategories";
const colRef = collection(db, COLLECTION);

export async function getIncomeCategories(): Promise<Record<string, string[]>> {
  const snapshot = await getDocs(colRef);
  if (snapshot.empty) return {};
  const result: Record<string, string[]> = {};
  for (const d of snapshot.docs) {
    const data = d.data();
    result[d.id] = Array.isArray(data.subCategories) ? data.subCategories : [];
  }
  return result;
}

export function onIncomeCategoriesSnapshot(
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

export async function addIncomeCategory(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await setDoc(doc(db, COLLECTION, trimmed), {
    name: trimmed,
    subCategories: [],
  });
}

export async function addIncomeSubCategory(
  categoryName: string,
  subCategoryName: string
): Promise<void> {
  const catTrimmed = categoryName.trim();
  const subTrimmed = subCategoryName.trim();
  if (!catTrimmed || !subTrimmed) return;
  const ref = doc(db, COLLECTION, catTrimmed);
  await updateDoc(ref, { subCategories: arrayUnion(subTrimmed) });
}

export async function deleteIncomeCategory(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await deleteDoc(doc(db, COLLECTION, trimmed));
}

export async function removeIncomeSubCategory(
  categoryName: string,
  subCategoryName: string
): Promise<void> {
  const catTrimmed = categoryName.trim();
  const subTrimmed = subCategoryName.trim();
  if (!catTrimmed || !subTrimmed) return;
  const ref = doc(db, COLLECTION, catTrimmed);
  await updateDoc(ref, { subCategories: arrayRemove(subTrimmed) });
}

export async function seedIncomeCategories(): Promise<void> {
  const existing = await getIncomeCategories();
  const promises: Promise<void>[] = [];

  for (const [name, subs] of Object.entries(INCOME_CATEGORIES)) {
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
    console.info(`[incomeCategoryService] seeded ${promises.length} income categories`);
  }
}
