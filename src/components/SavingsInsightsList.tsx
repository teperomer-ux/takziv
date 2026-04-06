import { useState, useEffect, useMemo } from "react";
import type { Transaction } from "../types";
import type { SavingsInsight } from "../types/smartSaver";
import type { RecurringCharge } from "../utils/recurringBills";
import type { UserFinancialProfile } from "../types/userProfile";
import {
  onInsightsSnapshot,
  saveInsights,
  generateSavingsInsights,
} from "../services/smartSaverService";

interface Props {
  recurringCharges: RecurringCharge[];
  allTransactions: Transaction[];
  profile: UserFinancialProfile;
}

export default function SavingsInsightsList({
  recurringCharges,
  allTransactions,
  profile,
}: Props) {
  const [rawInsights, setRawInsights] = useState<SavingsInsight[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // Subscribe to cached insights from Firestore
  useEffect(() => {
    return onInsightsSnapshot(
      setRawInsights,
      (err) => console.warn("[SavingsInsights] snapshot error:", err),
    );
  }, []);

  // UI-level safety net: never show zero-saving insights
  const insights = useMemo(
    () => rawInsights.filter((i) => i.potentialSaving > 0),
    [rawInsights],
  );

  const totalSaving = useMemo(
    () => insights.reduce((sum, i) => sum + i.potentialSaving, 0),
    [insights],
  );

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const fresh = generateSavingsInsights(recurringCharges, allTransactions, profile);
      await saveInsights(fresh);
    } catch (err) {
      console.error("[SavingsInsights] refresh failed:", err);
    } finally {
      setRefreshing(false);
    }
  }

  if (insights.length === 0 && recurringCharges.length === 0) return null;

  return (
    <div className="mb-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <span className="text-base leading-none">💡</span>
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">
            תובנות חיסכון חכמות
          </h3>
          {totalSaving > 0 && (
            <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 px-1.5 py-0.5 rounded-full">
              עד {totalSaving.toLocaleString("he-IL")} ₪/חודש
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-[11px] font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
        >
          {refreshing ? "מרענן..." : "רענן תובנות"}
        </button>
      </div>

      {/* Cards */}
      {insights.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory scrollbar-hide">
          {insights.map((insight) => (
            <div
              key={insight.id}
              className="snap-start shrink-0 w-[260px] rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-700/60 shadow-sm p-4 flex flex-col"
            >
              {/* Saving badge */}
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate max-w-[140px]">
                  {insight.businessName}
                </span>
                <span className="shrink-0 text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums" dir="ltr">
                  -{insight.potentialSaving.toLocaleString("he-IL")} ₪
                </span>
              </div>

              {/* Recommendation */}
              <p className="text-[12px] leading-relaxed text-slate-600 dark:text-slate-300 flex-1 mb-3">
                {insight.recommendationText}
              </p>

              {/* Club badge */}
              <div className="flex items-center gap-1.5">
                <span className="inline-block text-[10px] font-bold bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 px-2 py-0.5 rounded-full">
                  דרך {insight.clubUsed}
                </span>
                <span className="text-[10px] text-slate-400" dir="ltr">
                  {insight.currentAmount.toLocaleString("he-IL")} ₪/חודש
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-5 shadow-sm border border-slate-200/60 dark:border-slate-700/60 text-center">
          <p className="text-sm text-slate-400">
            אין תובנות חיסכון עדיין
          </p>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="mt-2 text-xs font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
          >
            {refreshing ? "מחפש חיסכון..." : "לחצו לסריקת חיסכון"}
          </button>
        </div>
      )}
    </div>
  );
}
