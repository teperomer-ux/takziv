import { useState, useEffect, useCallback, createContext, useContext } from "react";
import {
  onCategoriesSnapshot,
  addCategory as addCategoryToDb,
  addSubCategory as addSubCategoryToDb,
  deleteCategory as deleteCategoryFromDb,
  removeSubCategory as removeSubCategoryFromDb,
  renameCategory as renameCategoryInDb,
  seedCategories,
  setCategoryExcluded as setCategoryExcludedInDb,
} from "../services/categoryService";
import { CATEGORIES } from "../constants/categories";
import { INTERNAL_TRANSFERS, withDefaultExclusion } from "../utils/internalTransfers";

const DEFAULT_EXCLUDED: ReadonlySet<string> = new Set([INTERNAL_TRANSFERS]);

interface CategoriesContextValue {
  categories: Record<string, string[]>;
  categoryNames: string[];
  loading: boolean;
  addCategory: (name: string) => Promise<void>;
  addSubCategory: (category: string, subCategory: string) => Promise<void>;
  deleteCategory: (name: string) => Promise<void>;
  removeSubCategory: (category: string, subCategory: string) => Promise<void>;
  /** Categories left out of the monthly totals (e.g. internal transfers). */
  excludedCategories: ReadonlySet<string>;
  setCategoryExcluded: (name: string, excluded: boolean) => Promise<void>;
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
  excludedCategories: DEFAULT_EXCLUDED,
  setCategoryExcluded: async () => {},
  renameCategory: async () => {},
});

export function useCategoriesProvider(): CategoriesContextValue {
  const [categories, setCategories] = useState<Record<string, string[]>>(CATEGORIES);
  const [loading, setLoading] = useState(true);
  const [excludedCategories, setExcludedCategories] = useState<ReadonlySet<string>>(DEFAULT_EXCLUDED);

  useEffect(() => {
    // Seed static categories into Firestore (no-op if already present)
    seedCategories().catch((err) =>
      console.warn("[useCategories] seed failed:", err)
    );

    // Subscribe to real-time updates
    const unsub = onCategoriesSnapshot(
      (cats, excluded) => {
        setExcludedCategories(withDefaultExclusion(cats, excluded));
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
    await renameCategoryInDb(oldTrimmed, newTrimmed, subs, excludedCategories.has(oldTrimmed));
  }, [categories, excludedCategories]);

  const setCategoryExcluded = useCallback(async (name: string, excluded: boolean) => {
    setExcludedCategories((prev) => {
      const next = new Set(prev);
      if (excluded) next.add(name);
      else next.delete(name);
      return next;
    });
    await setCategoryExcludedInDb(name, excluded);
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
    excludedCategories,
    setCategoryExcluded,
    renameCategory: renameCat,
  };
}

/** Hook to consume the categories context */
export function useCategories(): CategoriesContextValue {
  return useContext(CategoriesContext);
}
