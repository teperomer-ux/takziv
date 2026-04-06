import { useState, useEffect, useCallback, createContext, useContext } from "react";
import {
  onIncomeCategoriesSnapshot,
  addIncomeCategory as addCategoryToDb,
  addIncomeSubCategory as addSubCategoryToDb,
  deleteIncomeCategory as deleteCategoryFromDb,
  removeIncomeSubCategory as removeSubCategoryFromDb,
  seedIncomeCategories,
} from "../services/incomeCategoryService";
import { INCOME_CATEGORIES } from "../constants/incomeCategories";

interface IncomeCategoriesContextValue {
  categories: Record<string, string[]>;
  categoryNames: string[];
  loading: boolean;
  addCategory: (name: string) => Promise<void>;
  addSubCategory: (category: string, subCategory: string) => Promise<void>;
  deleteCategory: (name: string) => Promise<void>;
  removeSubCategory: (category: string, subCategory: string) => Promise<void>;
}

export const IncomeCategoriesContext = createContext<IncomeCategoriesContextValue>({
  categories: INCOME_CATEGORIES,
  categoryNames: Object.keys(INCOME_CATEGORIES),
  loading: true,
  addCategory: async () => {},
  addSubCategory: async () => {},
  deleteCategory: async () => {},
  removeSubCategory: async () => {},
});

export function useIncomeCategoriesProvider(): IncomeCategoriesContextValue {
  const [categories, setCategories] = useState<Record<string, string[]>>(INCOME_CATEGORIES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    seedIncomeCategories().catch((err) =>
      console.warn("[useIncomeCategories] seed failed:", err)
    );

    const unsub = onIncomeCategoriesSnapshot(
      (cats) => {
        setCategories((prev) => ({ ...prev, ...cats }));
        setLoading(false);
      },
      (err) => {
        console.warn("[useIncomeCategories] snapshot error:", err);
        setLoading(false);
      }
    );

    return unsub;
  }, []);

  const addCategory = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCategories((prev) => ({ ...prev, [trimmed]: [] }));
    await addCategoryToDb(trimmed);
  }, []);

  const addSubCategory = useCallback(async (category: string, subCategory: string) => {
    const catTrimmed = category.trim();
    const subTrimmed = subCategory.trim();
    if (!catTrimmed || !subTrimmed) return;
    setCategories((prev) => ({
      ...prev,
      [catTrimmed]: [...(prev[catTrimmed] ?? []), subTrimmed],
    }));
    await addSubCategoryToDb(catTrimmed, subTrimmed);
  }, []);

  const deleteCat = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCategories((prev) => {
      const next = { ...prev };
      delete next[trimmed];
      return next;
    });
    await deleteCategoryFromDb(trimmed);
  }, []);

  const removeSubCat = useCallback(async (category: string, subCategory: string) => {
    const catTrimmed = category.trim();
    const subTrimmed = subCategory.trim();
    if (!catTrimmed || !subTrimmed) return;
    setCategories((prev) => ({
      ...prev,
      [catTrimmed]: (prev[catTrimmed] ?? []).filter((s) => s !== subTrimmed),
    }));
    await removeSubCategoryFromDb(catTrimmed, subTrimmed);
  }, []);

  const categoryNames = Object.keys(categories).sort((a, b) =>
    a.localeCompare(b, "he")
  );

  return {
    categories,
    categoryNames,
    loading,
    addCategory,
    addSubCategory,
    deleteCategory: deleteCat,
    removeSubCategory: removeSubCat,
  };
}

export function useIncomeCategories(): IncomeCategoriesContextValue {
  return useContext(IncomeCategoriesContext);
}
