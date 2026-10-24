import { collection, getDocs, writeBatch, type DocumentReference } from "firebase/firestore";
import { db } from "../lib/firebase";
import { getLearnedMappings } from "./mappingService";
import { suggestCategory, type ClassificationResult } from "../utils/classifier";
import { suggestIncomeCategory } from "../utils/incomeClassifier";
import { reclassification } from "../utils/internalTransfers";

export interface ReclassifyResult {
  expenses: number;
  incomes: number;
}

type Suggest = (description: string) => ClassificationResult | undefined;

/** Re-runs the classifier over one collection; returns how many rows changed. */
async function reclassifyCollection(
  userId: string,
  txCollection: "transactions" | "incomeTransactions",
  suggest: Suggest,
): Promise<number> {
  const snapshot = await getDocs(collection(db, "users", userId, txCollection));
  const updates: { ref: DocumentReference; category: string; subCategory: string }[] = [];

  for (const d of snapshot.docs) {
    const data = d.data();
    const row = { category: String(data.category ?? ""), subCategory: String(data.subCategory ?? "") };
    const next = reclassification(row, suggest(String(data.description ?? "")));
    if (next) updates.push({ ref: d.ref, ...next });
  }

  for (let i = 0; i < updates.length; i += 500) {
    const batch = writeBatch(db);
    for (const u of updates.slice(i, i + 500)) {
      batch.update(u.ref, { category: u.category, subCategory: u.subCategory });
    }
    await batch.commit();
  }
  return updates.length;
}

/**
 * One-time pass that applies the current rules (learned + fixed) to every
 * past row: fills in uncategorised rows and moves auto-categorised transfers
 * to "העברות פנימיות" or off the old generic-transfer category. Rows the user
 * categorised themselves are left as they are — see `reclassification`.
 */
export async function reapplyRulesToHistory(userId: string): Promise<ReclassifyResult> {
  const [expenseMappings, incomeMappings] = await Promise.all([
    getLearnedMappings(userId, "learnedMappings"),
    getLearnedMappings(userId, "learnedIncomeMappings"),
  ]);
  const [expenses, incomes] = await Promise.all([
    reclassifyCollection(userId, "transactions", (desc) => suggestCategory(desc, expenseMappings)),
    reclassifyCollection(userId, "incomeTransactions", (desc) => suggestIncomeCategory(desc, incomeMappings)),
  ]);
  return { expenses, incomes };
}
