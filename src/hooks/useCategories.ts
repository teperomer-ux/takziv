import { useState, useEffect, useCallback, createContext, useContext } from "react";
import {
  onCategoriesSnapshot,
  addCategory as addCategoryToDb,
  addSubCategory as addSubCategoryToDb,
  deleteCategory as deleteCategoryFromDb,
  removeSubCategory as removeSubCategoryFromDb,
  renameCategory as renameCategoryInDb,
  seedCategories,
} from "../services/categoryService";
import { CATEGORIES } from "../constants/categories";

interface CategoriesContextValue {
  categories: Record<string, string[]>;
  categoryNames: string[];
  loading: boolean;
  addCategory: (name: string) => Promise<void>;
  addSubCategory: (category: string, subCategory: string) => Promise<void>;
  deleteCategory: (name: string) => Promise<void>;
  removeSubCategory: (category: string, subCategory: string) => Promise<void>;
  renameCategory: (oldName: string, newName: string) => Promise<void>;
}

// ─── Context ────────────────────────────────────────────────────────────────

export const CategoriesContext = createContext<CategoriesContextValue>({
  categories: CATEGORIES,
  categoryNames: Object.keys(CATEGORIES),
  loading: true,
  addCategory: async () => {},
  addSubCategory: async () => {},
  deleteCategory: async () => {},
  removeSubCategory: async () => {},
  renameCategory: async () => {},
});

export function useCategoriesProvider(): CategoriesContextValue {
  const [categories, setCategories] = useState<Record<string, string[]>>(CATEGORIES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Seed static categories into Firestore (no-op if already present)
    seedCategories().catch((err) =>
      console.warn("[useCategories] seed failed:", err)
    );

    // Subscribe to real-time updates
    const unsub = onCategoriesSnapshot(
      (cats) => {
        // Merge: Firestore data takes precedence, but keep static as fallback
        setCategories((prev) => {
          const merged = { ...prev, ...cats };
          return merged;
        });
        setLoading(false);
      },
      (err) => {
        console.warn("[useCategories] snapshot error:", err);
        setLoading(false);
      }
    );

    return unsub;
  }, []);

  const addCategory = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Optimistic update
    setCategories((prev) => ({ ...prev, [trimmed]: [] }));
    await addCategoryToDb(trimmed);
  }, []);

  const addSubCategory = useCallback(async (category: string, subCategory: string) => {
    const catTrimmed = category.trim();
    const subTrimmed = subCategory.trim();
    if (!catTrimmed || !subTrimmed) return;
    // Optimistic update
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

  const renameCat = useCallback(async (oldName: string, newName: string) => {
    const oldTrimmed = oldName.trim();
    const newTrimmed = newName.trim();
    if (!oldTrimmed || !newTrimmed || oldTrimmed === newTrimmed) return;
    const subs = categories[oldTrimmed] ?? [];
    setCategories((prev) => {
      const next = { ...prev };
      delete next[oldTrimmed];
      next[newTrimmed] = subs;
      return next;
    });
    await renameCategoryInDb(oldTrimmed, newTrimmed, subs);
  }, [categories]);

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
    renameCategory: renameCat,
  };
}

/** Hook to consume the categories context */
export function useCategories(): CategoriesContextValue {
  return useContext(CategoriesContext);
}
