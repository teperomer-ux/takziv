import { useState, useEffect, useMemo, useCallback } from "react";
import type { Transaction } from "../types";
import { useCategories } from "../hooks/useCategories";
import { getAllTransactions } from "../services/transactionService";
import { computeUpcomingBills, type NewRecurringDetection } from "../utils/recurringBills";
import { onPinnedBillsSnapshot, pinBill, type PinnedBill } from "../services/pinnedBillsService";
import BottomLine from "./BottomLine";
import FinanceRings from "./FinanceRings";
import SmartInsights from "./SmartInsights";
import RecurringBills from "./RecurringBills";
import { useSettings } from "../hooks/useSettings";

interface Props {
  transactions: Transaction[];
  year: number;
  month: number;
  onOpenSettings: () => void;
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

export default function Dashboard({ transactions, year, month, onOpenSettings }: Props) {
  const { categoryNames } = useCategories();
  const { settings } = useSettings();
  const [allTxs, setAllTxs] = useState<Transaction[]>([]);
  const [loadingAvg, setLoadingAvg] = useState(true);
  const [pinnedBills, setPinnedBills] = useState<PinnedBill[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    getAllTransactions()
      .then(setAllTxs)
      .catch((err) => console.warn("[Dashboard] failed to load averages:", err))
      .finally(() => setLoadingAvg(false));
  }, []);

  // Subscribe to pinned recurring bills
  useEffect(() => {
    return onPinnedBillsSnapshot(
      setPinnedBills,
      (err) => console.warn("[Dashboard] pinned bills error:", err)
    );
  }, []);

  const pinnedDescriptions = useMemo(
    () => new Set(pinnedBills.map((b) => b.description)),
    [pinnedBills]
  );

  const handlePinBill = useCallback(
    async (det: NewRecurringDetection) => {
      try {
        await pinBill({
          description: det.description,
          avgAmount: det.amount,
          typicalDay: det.typicalDay,
        });
        setToast(`"${det.description}" נוסף להוצאות הקבועות`);
        setTimeout(() => setToast(null), 2500);
      } catch (err) {
        console.error("[Dashboard] pin bill failed:", err);
      }
    },
    []
  );

  const averages = useMemo(() => computeAverages(allTxs), [allTxs]);

  const autoBills = useMemo(
    () => computeUpcomingBills(allTxs, year, month),
    [allTxs, year, month]
  );

  // Merge auto-detected bills with user-pinned bills (pinned take priority)
  const upcomingBills = useMemo(() => {
    const autoDescs = new Set(autoBills.map((b) => b.description));

    // Add pinned bills that aren't already in auto-detected
    const extras = pinnedBills
      .filter((pb) => !autoDescs.has(pb.description))
      .map((pb) => ({
        description: pb.description,
        avgAmount: pb.avgAmount,
        typicalDay: pb.typicalDay,
        monthCount: 2,
      }));

    const merged = [...autoBills, ...extras];
    merged.sort((a, b) => a.typicalDay - b.typicalDay);
    return merged;
  }, [autoBills, pinnedBills]);

  const expectedRecurring = useMemo(
    () => upcomingBills.reduce((sum, b) => sum + b.avgAmount, 0),
    [upcomingBills]
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

  // Build rows for every category that has either spending this month or an average
  const rows = categoryNames
    .map((cat) => {
      const spent = spending.get(cat) ?? 0;
      const avg = averages.get(cat) ?? 0;
      if (spent === 0 && avg === 0) return null;
      return { cat, spent, avg };
    })
    .filter(Boolean) as { cat: string; spent: number; avg: number }[];

  rows.sort((a, b) => {
    if (a.spent > 0 && b.spent === 0) return -1;
    if (a.spent === 0 && b.spent > 0) return 1;
    return b.spent - a.spent;
  });

  // Total average = sum of all category averages (for summary card)
  let totalAvg = 0;
  for (const avg of averages.values()) totalAvg += avg;

  const totalPct = totalAvg > 0 ? Math.min((totalSpent / totalAvg) * 100, 100) : 0;
  const totalOver = totalSpent > totalAvg;

  return (
    <section>
      {/* ── Toast ──────────────────────────────────────────────── */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-slate-800 text-white px-4 py-2.5 text-sm shadow-lg animate-[fadeIn_0.2s_ease-out]">
          {toast}
        </div>
      )}

      {/* ── Bottom Line (Hero) ──────────────────────────────────── */}
      {!loadingAvg && (
        <BottomLine
          totalSpent={totalSpent}
          expectedRecurring={expectedRecurring}
          year={year}
          month={month}
          onOpenSettings={onOpenSettings}
        />
      )}

      {/* ── Smart Insights ────────────────────────────────────── */}
      {!loadingAvg && (
        <SmartInsights
          transactions={transactions}
          averages={averages}
          allTransactions={allTxs}
          pinnedDescriptions={pinnedDescriptions}
          onPinBill={handlePinBill}
        />
      )}

      {/* ── Finance Rings ─────────────────────────────────────── */}
      {!loadingAvg && (
        <FinanceRings
          totalSpent={totalSpent}
          income={settings.partner1Income + settings.partner2Income}
          variableSpending={Math.max(totalSpent - expectedRecurring, 0)}
          monthlyAverage={totalAvg}
        />
      )}

      {/* ── Summary card ──────────────────────────────────────── */}
      <div className="rounded-xl bg-primary p-5 text-white shadow-md mb-5">
        <p className="text-sm text-white/70 mb-1">
          הוצאות {MONTH_NAMES[month - 1]} {year}
        </p>
        <div className="flex items-end justify-between mb-3">
          <span className="text-3xl font-bold">
            {totalSpent.toLocaleString("he-IL")} ₪
          </span>
          <span className="text-sm text-white/70">
            {loadingAvg
              ? "טוען ממוצע..."
              : `ממוצע: ${Math.round(totalAvg).toLocaleString("he-IL")} ₪`}
          </span>
        </div>
        {/* Total progress bar */}
        <div className="h-2.5 rounded-full bg-white/20 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              totalOver ? "bg-red-400" : "bg-emerald-400"
            }`}
            style={{ width: `${totalPct}%` }}
          />
        </div>
        <div className="flex justify-between mt-1.5 text-xs text-white/60">
          <span>{totalPct.toFixed(0)}% מהממוצע</span>
          <span>
            {totalOver
              ? `חריגה של ${Math.round(totalSpent - totalAvg).toLocaleString("he-IL")} ₪`
              : `נותרו ${Math.round(totalAvg - totalSpent).toLocaleString("he-IL")} ₪`}
          </span>
        </div>
      </div>

      {/* ── Uncategorized alert ─────────────────────────────────── */}
      {uncategorizedCount > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 mb-4 text-sm text-amber-700">
          {uncategorizedCount} עסקאות ללא סיווג — עברו להיסטוריה כדי לסווג אותן.
        </div>
      )}

      {/* ── Recurring Bills Radar ─────────────────────────────── */}
      {!loadingAvg && <RecurringBills bills={upcomingBills} />}

      {/* ── Category breakdown ────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-500">
          פירוט לפי סעיף
        </h3>
        <span className="text-xs text-slate-400">
          {transactions.length} עסקאות
        </span>
      </div>

      {loadingAvg ? (
        <div className="flex justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(({ cat, spent, avg }) => {
            const over = spent > avg;
            const maxVal = Math.max(spent, avg, 1);
            const spentPct = (spent / maxVal) * 100;
            const avgPct = (avg / maxVal) * 100;

            return (
              <div
                key={cat}
                className="rounded-xl bg-white p-4 shadow-sm border border-slate-100"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-slate-700">{cat}</span>
                  <span className={`text-xs font-medium ${over ? "text-red-500" : "text-slate-400"}`}>
                    {spent.toLocaleString("he-IL")} / {Math.round(avg).toLocaleString("he-IL")} ₪
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mb-2">
                  ממוצע: {Math.round(avg).toLocaleString("he-IL")} ₪
                </p>

                <div className="relative h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="absolute top-0 h-full w-0.5 bg-slate-300 z-10"
                    style={{ right: `${100 - avgPct}%` }}
                  />
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      over ? "bg-red-400" : "bg-emerald-500"
                    }`}
                    style={{ width: `${spentPct}%` }}
                  />
                </div>

                {over && (
                  <p className="text-[11px] text-red-500 mt-1">
                    חריגה של {Math.round(spent - avg).toLocaleString("he-IL")} ₪ מעל הממוצע
                  </p>
                )}
                {!over && spent > 0 && (
                  <p className="text-[11px] text-emerald-600 mt-1">
                    חיסכון של {Math.round(avg - spent).toLocaleString("he-IL")} ₪ מתחת לממוצע
                  </p>
                )}
              </div>
            );
          })}

          {rows.every((r) => r.spent === 0) && (
            <p className="text-center text-sm text-slate-400 py-8">
              אין עדיין הוצאות החודש. העלו דף חיוב כדי להתחיל.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
