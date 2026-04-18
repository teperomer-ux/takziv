import { useState, useEffect, useMemo } from "react";
import type { Transaction } from "../types";
import { getAllTransactions } from "../services/transactionService";
import { onIncomeTransactionsSnapshot } from "../services/incomeTransactionService";
import { calculateRecurringAndAlerts } from "../utils/recurringBills";
import {
  onAdditionalExpensesSnapshot,
  expenseTotalForMonth,
  type AdditionalExpense,
} from "../services/additionalExpenseService";
import { getFinancialProfile } from "../services/userProfileService";
import { DEFAULT_FINANCIAL_PROFILE, type UserFinancialProfile } from "../types/userProfile";
import BottomLine from "./BottomLine";
import SmartInsights from "./SmartInsights";
import MonthlyTrend from "./MonthlyTrend";
import CategoryBreakdown from "./CategoryBreakdown";
import SmartSaverOnboarding from "./SmartSaverOnboarding";
import SavingsInsightsList from "./SavingsInsightsList";

interface Props {
  transactions: Transaction[];
  year: number;
  month: number;
  onShowUncategorized: () => void;
}

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

/** Compute per-category monthly averages from all historical transactions. */
function computeAverages(allTxs: Transaction[]): Map<string, number> {
  const catMonths = new Map<string, Map<string, number>>();

  for (const tx of allTxs) {
    if (tx.category === "מקורות הכנסה" || !tx.category) continue;
    const monthKey = tx.date.slice(0, 7);

    let months = catMonths.get(tx.category);
    if (!months) {
      months = new Map();
      catMonths.set(tx.category, months);
    }
    months.set(monthKey, (months.get(monthKey) ?? 0) + tx.amount);
  }

  const averages = new Map<string, number>();
  for (const [cat, months] of catMonths) {
    let total = 0;
    for (const v of months.values()) total += v;
    averages.set(cat, total / months.size);
  }
  return averages;
}

export default function Dashboard({ transactions, year, month, onShowUncategorized }: Props) {
  const [allTxs, setAllTxs] = useState<Transaction[]>([]);
  const [loadingAvg, setLoadingAvg] = useState(true);
  const [additionalExpenses, setAdditionalExpenses] = useState<AdditionalExpense[]>([]);
  const [incomeTransactions, setIncomeTransactions] = useState<Transaction[]>([]);
  const [activeChart, setActiveChart] = useState<"months" | "categories">("categories");
  const [smartSaverOpen, setSmartSaverOpen] = useState(false);
  const [hasProfile, setHasProfile] = useState(true);
  const [financialProfile, setFinancialProfile] = useState<UserFinancialProfile>({
    ...DEFAULT_FINANCIAL_PROFILE,
  });

  // Load financial profile; auto-popup onboarding if empty
  useEffect(() => {
    getFinancialProfile().then((p) => {
      setFinancialProfile(p);
      const empty =
        p.banks.length === 0 &&
        p.creditCards.length === 0 &&
        p.consumerClubs.length === 0 &&
        p.walletsAndVouchers.length === 0;
      setHasProfile(!empty);
      if (empty) setSmartSaverOpen(true);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    getAllTransactions()
      .then((txs) => {
        setAllTxs(txs);

        // Debug: confirm what billing-month buckets exist after every refresh
        const buckets = new Map<string, number>();
        for (const tx of txs) {
          const key = `${tx.billingYear}-${String(tx.billingMonth).padStart(2, "0")}`;
          buckets.set(key, (buckets.get(key) ?? 0) + 1);
        }
        console.log("🚨 ALL-TXS REFRESHED 🚨", {
          totalTransactions: txs.length,
          buckets: Object.fromEntries([...buckets.entries()].sort()),
        });
      })
      .catch((err) => console.warn("[Dashboard] failed to load averages:", err))
      .finally(() => setLoadingAvg(false));
  }, [transactions]);

  // Subscribe to income transactions for current month
  useEffect(() => {
    return onIncomeTransactionsSnapshot(
      year,
      month,
      setIncomeTransactions,
      (err) => console.warn("[Dashboard] income transactions error:", err),
    );
  }, [year, month]);

  // Subscribe to additional expenses
  useEffect(() => {
    return onAdditionalExpensesSnapshot(
      setAdditionalExpenses,
      (err) => console.warn("[Dashboard] additional expenses error:", err),
    );
  }, []);

  const extraExpense = useMemo(
    () => expenseTotalForMonth(additionalExpenses, year, month),
    [additionalExpenses, year, month],
  );

  // Dynamic total income from uploaded income transactions
  const totalIncome = useMemo(
    () => incomeTransactions.reduce((sum, tx) => sum + tx.amount, 0),
    [incomeTransactions],
  );

  const averages = useMemo(() => computeAverages(allTxs), [allTxs]);

  const { charges: recurringCharges, alerts: recurringAlerts } = useMemo(
    () => calculateRecurringAndAlerts(allTxs, year, month),
    [allTxs, year, month],
  );

  // Aggregate current month spending per category (exclude income)
  const spending = new Map<string, number>();
  let totalSpent = 0;
  let uncategorizedCount = 0;

  for (const tx of transactions) {
    if (tx.category === "מקורות הכנסה") continue;
    if (!tx.category) {
      uncategorizedCount++;
      continue;
    }
    spending.set(tx.category, (spending.get(tx.category) ?? 0) + tx.amount);
    totalSpent += tx.amount;
  }

  // Include manually-added expenses in total
  totalSpent += extraExpense;

  // Total average = sum of all category averages (for summary card)
  let totalAvg = 0;
  for (const avg of averages.values()) totalAvg += avg;

  const totalPct = totalAvg > 0 ? Math.min((totalSpent / totalAvg) * 100, 100) : 0;
  const totalOver = totalSpent > totalAvg;

  return (
    <section>
      {/* ── Charts Section (top of dashboard) ─────────────────── */}
      {!loadingAvg && (
        <div className="rounded-2xl bg-white dark:bg-slate-900 shadow-sm border border-slate-200/60 dark:border-slate-700/60 mb-5 overflow-hidden">
          {/* Segmented control */}
          <div className="p-4 pb-0">
            <div className="relative flex rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
              {/* Sliding pill */}
              <div
                className="absolute top-1 bottom-1 rounded-lg bg-white dark:bg-slate-700 shadow-sm transition-all duration-300 ease-out"
                style={{
                  width: "calc(50% - 4px)",
                  right: activeChart === "months" ? "4px" : "calc(50%)",
                }}
              />
              <button
                onClick={() => setActiveChart("months")}
                className={`relative z-10 flex-1 py-2 text-xs font-semibold rounded-lg transition-colors duration-200 ${
                  activeChart === "months"
                    ? "text-slate-800 dark:text-slate-100"
                    : "text-slate-400 dark:text-slate-500"
                }`}
              >
                גרף חודשים
              </button>
              <button
                onClick={() => setActiveChart("categories")}
                className={`relative z-10 flex-1 py-2 text-xs font-semibold rounded-lg transition-colors duration-200 ${
                  activeChart === "categories"
                    ? "text-slate-800 dark:text-slate-100"
                    : "text-slate-400 dark:text-slate-500"
                }`}
              >
                גרף קטגוריות
              </button>
            </div>
          </div>

          {/* Chart content */}
          <div className="p-4">
            {activeChart === "months" ? (
              <MonthlyTrend allTransactions={allTxs} year={year} month={month} />
            ) : (
              <CategoryBreakdown spending={spending} totalSpent={totalSpent} />
            )}
          </div>
        </div>
      )}

      {/* ── Bottom Line (Hero) ──────────────────────────────────── */}
      {!loadingAvg && (
        <BottomLine
          totalIncome={totalIncome}
          totalSpent={totalSpent}
          year={year}
          month={month}
        />
      )}

      {/* ── Smart Insights ────────────────────────────────────── */}
      {!loadingAvg && (
        <SmartInsights
          transactions={transactions}
          averages={averages}
          onShowUncategorized={onShowUncategorized}
        />
      )}

      {/* ── Summary card ──────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-bl from-red-800 to-red-900 dark:from-red-900 dark:to-red-950 p-5 text-white shadow-lg mb-5">
        <p className="text-sm text-white/60 mb-1">
          הוצאות {MONTH_NAMES[month - 1]} {year}
        </p>
        <div className="flex items-end justify-between mb-3">
          <span className="text-3xl font-bold tracking-tight">
            {totalSpent.toLocaleString("he-IL")} ₪
          </span>
          <span className="text-sm text-white/60">
            {loadingAvg
              ? "טוען ממוצע..."
              : `ממוצע: ${Math.round(totalAvg).toLocaleString("he-IL")} ₪`}
          </span>
        </div>
        {/* Total progress bar */}
        <div className="h-2.5 rounded-full bg-red-950/60 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500 bg-white/30"
            style={{ width: `${totalPct}%` }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-white/50">
          <span>{totalPct.toFixed(0)}% מהממוצע</span>
          <span>
            {totalOver
              ? `חריגה של ${Math.round(totalSpent - totalAvg).toLocaleString("he-IL")} ₪`
              : `נותרו ${Math.round(totalAvg - totalSpent).toLocaleString("he-IL")} ₪`}
          </span>
        </div>

      </div>

      {/* ── Savings Insights ────────────────────────────────────── */}
      {!loadingAvg && (
        <SavingsInsightsList
          recurringCharges={recurringCharges}
          allTransactions={allTxs}
          profile={financialProfile}
        />
      )}

      {/* ── Uncategorized alert ─────────────────────────────────── */}
      {uncategorizedCount > 0 && (
        <button
          onClick={onShowUncategorized}
          className="w-full text-start rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-700/40 px-4 py-3.5 mb-5 text-sm text-amber-800 dark:text-amber-300 font-medium hover:bg-amber-100/60 dark:hover:bg-amber-950/50 transition-colors cursor-pointer"
        >
          {uncategorizedCount} עסקאות ללא סיווג — לחצו כאן כדי לסווג אותן
          <span className="inline-block mr-1 text-amber-500">&larr;</span>
        </button>
      )}

      {/* ── Recurring Charges ─────────────────────────────────── */}
      {!loadingAvg && (
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3 px-1">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-500" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
            </svg>
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">
              חיובים קבועים
            </h3>
            {recurringCharges.length > 0 && (
              <span className="text-[11px] text-slate-400 font-medium">
                ({recurringCharges.length})
              </span>
            )}
          </div>

          {/* ── Recurring alerts ──────────────────────────────── */}
          {recurringAlerts.length > 0 && (
            <div className="space-y-2 mb-3">
              {recurringAlerts.map((alert) => (
                <div
                  key={`${alert.kind}-${alert.description}`}
                  className={`flex items-start gap-3 rounded-2xl px-4 py-3 text-sm font-medium border ${
                    alert.kind === "stopped"
                      ? "bg-red-50 dark:bg-red-950/30 border-red-200/60 dark:border-red-800/40 text-red-800 dark:text-red-300"
                      : alert.kind === "amount-changed"
                      ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200/60 dark:border-amber-800/40 text-amber-800 dark:text-amber-300"
                      : "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200/60 dark:border-emerald-800/40 text-emerald-800 dark:text-emerald-300"
                  }`}
                >
                  <span className="shrink-0 mt-0.5">
                    {alert.kind === "stopped" ? (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    ) : alert.kind === "amount-changed" ? (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                  <span>
                    {alert.kind === "stopped"
                      ? `זוהתה הפסקה של חיוב קבוע: ${alert.description}`
                      : alert.kind === "amount-changed"
                      ? `סכום החיוב של ${alert.description} השתנה ב-${Math.abs(alert.diff!).toLocaleString("he-IL")} ש״ח (מ-${alert.previousAmount!.toLocaleString("he-IL")} ל-${alert.currentAmount!.toLocaleString("he-IL")})`
                      : `זוהה חיוב קבוע חדש: ${alert.description}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {recurringCharges.length === 0 ? (
            <div className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-5 shadow-sm border border-slate-200/60 dark:border-slate-700/60 text-center">
              <p className="text-sm text-slate-400">
                לא זוהו חיובים קבועים עדיין
              </p>
              <p className="text-[11px] text-slate-300 dark:text-slate-500 mt-1">
                נדרשים לפחות חודשיים של נתונים דומים
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {recurringCharges.map((charge) => (
                <div
                  key={charge.description}
                  className="flex items-center gap-3 rounded-2xl bg-white dark:bg-slate-900 px-4 py-3.5 shadow-sm border border-slate-200/60 dark:border-slate-700/60"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                      {charge.description}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-bold text-slate-700 dark:text-slate-200 tabular-nums" dir="ltr">
                    {Math.round(charge.amountM).toLocaleString("he-IL")} ₪
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* ── Smart Saver CTA ─────────────────────────────────── */}
      {!loadingAvg && (
        <button
          onClick={() => setSmartSaverOpen(true)}
          className="w-full flex items-center gap-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 px-4 py-3.5 mt-2 mb-5 shadow-sm hover:shadow-md transition-all"
        >
          <div className="h-8 w-8 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-1 text-start">
            <p className="text-sm font-bold text-white">
              {hasProfile ? "עדכון פרופיל חיסכון" : "הגדר פרופיל חסכון חכם"}
            </p>
            <p className="text-[11px] text-white/70">
              {hasProfile ? "ערוך את הבנקים, כרטיסים ומועדונים שלך" : "נמצא לך הנחות על סמך הכרטיסים והמועדונים שלך"}
            </p>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white/60 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </button>
      )}

      {/* ── Smart Saver Onboarding Modal ────────────────────── */}
      {smartSaverOpen && (
        <SmartSaverOnboarding
          onDone={() => {
            setSmartSaverOpen(false);
            setHasProfile(true);
            getFinancialProfile().then(setFinancialProfile).catch(() => {});
          }}
          onSkip={() => setSmartSaverOpen(false)}
        />
      )}
    </section>
  );
}
