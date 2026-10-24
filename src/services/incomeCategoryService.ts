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
import { db, getUid, getUidOrNull } from "../lib/firebase";
import { INCOME_CATEGORIES } from "../constants/incomeCategories";
import { INCOME_EXCLUDE_FIELD, INTERNAL_TRANSFERS, readExcludeFlag } from "../utils/internalTransfers";

const COLLECTION = "incomeCategories";
const NOOP = () => {};

function userCol() {
  return collection(db, "users", getUid(), COLLECTION);
}

function userDoc(docId: string) {
  return doc(db, "users", getUid(), COLLECTION, docId);
}

export async function getIncomeCategories(): Promise<Record<string, string[]>> {
  if (!getUidOrNull()) return {};
  const snapshot = await getDocs(userCol());
  if (snapshot.empty) return {};
  const result: Record<string, string[]> = {};
  for (const d of snapshot.docs) {
    const data = d.data();
    result[d.id] = Array.isArray(data.subCategories) ? data.subCategories : [];
  }
  return result;
}

export function onIncomeCategoriesSnapshot(
  callback: (cats: Record<string, string[]>, excluded: string[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!getUidOrNull()) { callback({}, []); return NOOP; }
  return onSnapshot(
    userCol(),
    (snapshot) => {
      const result: Record<string, string[]> = {};
      const excluded: string[] = [];
      for (const d of snapshot.docs) {
        const data = d.data();
        result[d.id] = Array.isArray(data.subCategories) ? data.subCategories : [];
        if (readExcludeFlag(d.id, data[INCOME_EXCLUDE_FIELD])) excluded.push(d.id);
      }
      callback(result, excluded);
    },
    onError
  );
}

/** Mark an income category as left out of (or counted in) the income totals. */
export async function setIncomeCategoryExcluded(name: string, excluded: boolean): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await updateDoc(userDoc(trimmed), { [INCOME_EXCLUDE_FIELD]: excluded });
}

export async function addIncomeCategory(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await setDoc(userDoc(trimmed), {
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
  await updateDoc(userDoc(catTrimmed), { subCategories: arrayUnion(subTrimmed) });
}

export async function deleteIncomeCategory(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await deleteDoc(userDoc(trimmed));
}

export async function removeIncomeSubCategory(
  categoryName: string,
  subCategoryName: string
): Promise<void> {
  const catTrimmed = categoryName.trim();
  const subTrimmed = subCategoryName.trim();
  if (!catTrimmed || !subTrimmed) return;
  await updateDoc(userDoc(catTrimmed), { subCategories: arrayRemove(subTrimmed) });
}

export async function seedIncomeCategories(): Promise<void> {
  if (!getUidOrNull()) return;
  const existing = await getIncomeCategories();
  const promises: Promise<void>[] = [];

  for (const [name, subs] of Object.entries(INCOME_CATEGORIES)) {
    if (!(name in existing)) {
      promises.push(
        setDoc(userDoc(name), {
          name,
          subCategories: subs,
          ...(name === INTERNAL_TRANSFERS && { [INCOME_EXCLUDE_FIELD]: true }),
        })
      );
    }
  }

  if (promises.length > 0) {
    await Promise.all(promises);
    console.info(`[incomeCategoryService] seeded ${promises.length} income categories`);
  }
}
