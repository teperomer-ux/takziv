import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import type { Transaction } from "../types";
import { X } from "lucide-react";
import { loadTransactionHistory, mergeMonthIntoHistory } from "../services/transactionService";
import { loadIncomeHistory, onIncomeTransactionsSnapshot } from "../services/incomeTransactionService";
import { detectRecurring, FIXED_KIND_LABELS } from "../utils/recurringBills";
import { buildInsights } from "../utils/insights";
import { buildSavingsProfile } from "../utils/savingsProfile";
import {
  cycleIndex,
  cycleStatus,
  daysInMonth,
  fromMonthIndex,
  isFutureCharge,
  monthIndex,
  parseYmd,
  ymKey,
} from "../utils/billingCycle";
import { israelYmd } from "../utils/formatDate";
import { matchCreditCardCompany } from "../utils/bankReconciliation";
import {
  onAdditionalExpensesSnapshot,
  expenseTotalForMonth,
  type AdditionalExpense,
} from "../services/additionalExpenseService";
import { getFinancialProfile } from "../services/userProfileService";
import { DEFAULT_FINANCIAL_PROFILE, type UserFinancialProfile } from "../types/userProfile";
import BottomLine from "./BottomLine";
import SmartInsights from "./SmartInsights";
import SmartSaverOnboarding from "./SmartSaverOnboarding";
import SavingsInsightsList from "./SavingsInsightsList";
import SavingsProfileCard from "./SavingsProfileCard";
import BankSyncModal from "./BankSyncModal";
import { useCategories } from "../hooks/useCategories";
import { useIncomeCategories } from "../hooks/useIncomeCategories";
import { useBankSync } from "../hooks/useBankSync";
import { useSettings } from "../hooks/useSettings";
import { isExcludedFromTotals, splitTotals } from "../utils/internalTransfers";

// Recharts is most of the bundle; the charts load in their own chunk.
const MonthlyTrend = lazy(() => import("./MonthlyTrend"));
const CategoryBreakdown = lazy(() => import("./CategoryBreakdown"));

/** Holds the chart's place while its chunk loads, so the page doesn't jump. */
function ChartFallback() {
  return <div className="h-56 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" aria-hidden="true" />;
}

interface Props {
  /** Every row of the viewed billing month, future charges included. */
  transactions: Transaction[];
  year: number;
  month: number;
  /** The user asked to see the viewed month's future charges in its total. */
  showFuture: boolean;
  onShowUncategorized: () => void;
}

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

/**
 * The income category — excluded from every expense aggregation in this file.
 */
const INCOME_CATEGORY = "מקורות הכנסה";

/** Result of `aggregateBudgetSpending` — what the progress bars read from. */
interface BudgetAggregation {
  /** Total amount per category for the month (categorised rows only). */
  spending: Map<string, number>;
  /** Sum across all categories — drives the global progress bar. */
  totalSpent: number;
  /** Rows that have no category yet; surfaced as the "לסיווג" CTA. */
  uncategorizedCount: number;
}

/**
 * Aggregate the budget/category progress bars for the active month.
 *
 * Inputs include rows from EVERY source — credit-card files (max | isracard |
 * cal) AND direct עו״ש imports (source === "bank") — so mortgage, fees, cash
 * withdrawals and standing orders all count toward their categories alongside
 * card purchases.
 *
 * Double-counting safety net: if a bank row happens to describe a monthly
 * credit-card bill payment ("חיוב מקס", "ישראכרט חיוב", "כאל", "MAX", etc.),
 * we DROP it. The individual purchases on that card are already in the same
 * transactions array as detailed CC rows; counting the aggregate bank deduction
 * on top would double-count the entire CC bill. `matchCreditCardCompany`
 * returns the provider slug for any description that looks like such a
 * payment, or null when it's a normal bank expense.
 *
 * Income rows and blank-category rows are excluded — income is its own card,
 * and uncategorised rows are surfaced separately so the user can sort them.
 * Rows in a category flagged excludeFromExpenseTotals (internal transfers:
 * buying securities, deposits) are money the user still owns, not spending.
 */
function aggregateBudgetSpending(
  transactions: Transaction[],
  excludedCategories: ReadonlySet<string>,
): BudgetAggregation {
  const spending = new Map<string, number>();
  let totalSpent = 0;
  let uncategorizedCount = 0;

  for (const tx of transactions) {
    // Income lives in its own collection — never count it as spending.
    if (tx.category === INCOME_CATEGORY) continue;

    // Defensive de-duplication: a bank row whose description matches a known
    // CC bill keyword is the lump-sum statement payment. The individual
    // purchases that made up that lump sum are already in `transactions` as
    // their own tagged CC rows, so this row would double-count if added.
    if (tx.source === "bank" && matchCreditCardCompany(tx.description)) {
      continue;
    }

    if (!tx.category) {
      uncategorizedCount++;
      continue;
    }
    if (isExcludedFromTotals(tx.category, excludedCategories)) continue;

    spending.set(tx.category, (spending.get(tx.category) ?? 0) + tx.amount);
    totalSpent += tx.amount;
  }

  return { spending, totalSpent, uncategorizedCount };
}

/** Complete months the "usual month" average is taken over. */
const AVERAGE_MONTHS = 6;

/**
 * Per-category average of a usual month: the (up to) six billing months
 * before the viewed one. The viewed month itself is left out — it would be
 * compared with itself — and so are future charges (the caller removes them).
 * A month in which a category had no spending counts as zero for it.
 */
function computeAverages(
  allTxs: Transaction[],
  excludedCategories: ReadonlySet<string>,
  year: number,
  month: number,
): Map<string, number> {
  const viewed = monthIndex(year, month);
  const months = new Set<number>();
  const totals = new Map<string, number>();

  for (const tx of allTxs) {
    if (tx.category === INCOME_CATEGORY || !tx.category) continue;
    if (isExcludedFromTotals(tx.category, excludedCategories)) continue;
    // Mirror the budget aggregator's safety net: bank-side CC bill rows are
    // the lump-sum statement payment, not real category spending.
    if (tx.source === "bank" && matchCreditCardCompany(tx.description)) continue;
    const idx = cycleIndex(tx);
    if (idx >= viewed || idx < viewed - AVERAGE_MONTHS) continue;
    months.add(idx);
    totals.set(tx.category, (totals.get(tx.category) ?? 0) + tx.amount);
  }

  const averages = new Map<string, number>();
  for (const [cat, total] of totals) averages.set(cat, total / months.size);
  return averages;
}

export default function Dashboard({ transactions, year, month, showFuture, onShowUncategorized }: Props) {
  const { excludedCategories: excludedExpenseCategories } = useCategories();
  const { excludedCategories: excludedIncomeCategories } = useIncomeCategories();
  const { connections } = useBankSync();
  const { settings, updateSettings } = useSettings();
  const [history, setHistory] = useState<Transaction[]>([]);
  const [incomeHistory, setIncomeHistory] = useState<Transaction[]>([]);
  const [loadingAvg, setLoadingAvg] = useState(true);
  const [additionalExpenses, setAdditionalExpenses] = useState<AdditionalExpense[]>([]);
  const [incomeTransactions, setIncomeTransactions] = useState<Transaction[]>([]);
  const [activeChart, setActiveChart] = useState<"months" | "categories">("categories");
  const [smartSaverOpen, setSmartSaverOpen] = useState(false);
  const [bankSyncOpen, setBankSyncOpen] = useState(false);
  const [hasProfile, setHasProfile] = useState(true);
  const [financialProfile, setFinancialProfile] = useState<UserFinancialProfile>({
    ...DEFAULT_FINANCIAL_PROFILE,
  });
  /** Today in Israel, YYYY-MM-DD — what "future charge" and "running month" are measured against. */
  const today = israelYmd(new Date());

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

  // Full history for averages / trend / fixed charges / savings profile: read
  // once per session (see loadTransactionHistory), again only after a bank sync.
  const lastImportAt = useMemo(
    () => Math.max(0, ...connections.map((c) => (c.lastSyncAt ? Date.parse(c.lastSyncAt) : 0))),
    [connections],
  );
  useEffect(() => {
    let active = true;
    loadTransactionHistory(lastImportAt)
      .then((txs) => {
        if (active) setHistory(txs);
      })
      .catch((err) => console.warn("[Dashboard] failed to load averages:", err))
      .finally(() => {
        if (active) setLoadingAvg(false);
      });
    loadIncomeHistory(lastImportAt)
      .then((rows) => {
        if (active) setIncomeHistory(rows);
      })
      .catch((err) => console.warn("[Dashboard] failed to load income history:", err));
    return () => {
      active = false;
    };
  }, [lastImportAt]);

  // The month on screen comes from its live listener, so edits, deletes and
  // new rows show up in the averages without re-reading the history.
  // (mergeMonthIntoHistory updates the session cache; it's idempotent.)
  const allTxs = useMemo(
    () => mergeMonthIntoHistory(year, month, transactions) ?? history,
    [history, year, month, transactions],
  );

  // ── Billing-cycle boundary ───────────────────────────────────────
  // Card charges of a month that hasn't started yet are future charges:
  // nothing below — averages, trend, fixed charges, insights, savings
  // profile — ever sees them. The viewed month's own total shows them only
  // when the user asked to (showFuture).
  const visibleTxs = useMemo(() => allTxs.filter((tx) => !isFutureCharge(tx, today)), [allTxs, today]);
  const monthRows = useMemo(
    () => (showFuture ? transactions : transactions.filter((tx) => !isFutureCharge(tx, today))),
    [transactions, showFuture, today],
  );

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

  // Operating income only — internal transfers (between own accounts,
  // selling securities, …) are reported beside it, not added to it.
  const income = useMemo(
    () => splitTotals(incomeTransactions, excludedIncomeCategories),
    [incomeTransactions, excludedIncomeCategories],
  );

  const averages = useMemo(
    () => computeAverages(visibleTxs, excludedExpenseCategories, year, month),
    [visibleTxs, excludedExpenseCategories, year, month],
  );

  // ── Fixed charges ────────────────────────────────────────────────
  const recurringOptions = useMemo(
    () => ({
      fixed: new Set(settings.fixedMerchants),
      notFixed: new Set(settings.notFixedMerchants),
      excludedCategories: excludedExpenseCategories,
      today,
    }),
    [settings.fixedMerchants, settings.notFixedMerchants, excludedExpenseCategories, today],
  );
  const recurring = useMemo(
    () => detectRecurring(visibleTxs, year, month, recurringOptions),
    [visibleTxs, year, month, recurringOptions],
  );
  const recurringCharges = recurring.charges;
  const stoppedAlerts = recurring.alerts.filter((a) => a.kind === "stopped");

  function markNotFixed(key: string) {
    updateSettings({
      notFixedMerchants: [...settings.notFixedMerchants.filter((k) => k !== key), key],
      fixedMerchants: settings.fixedMerchants.filter((k) => k !== key),
    }).catch((err) => console.error("[Dashboard] saving fixed marking failed:", err));
  }

  // ── Insights ─────────────────────────────────────────────────────
  const insights = useMemo(
    () =>
      buildInsights({
        history: visibleTxs,
        year,
        month,
        today,
        excludedCategories: excludedExpenseCategories,
        recurring,
      }),
    [visibleTxs, year, month, today, excludedExpenseCategories, recurring],
  );

  // ── Savings profile ──────────────────────────────────────────────
  // A property of the household, not of the viewed month: always built from
  // the complete months before today.
  const savingsProfile = useMemo(() => {
    const [ty, tm] = parseYmd(today);
    const lastComplete = monthIndex(ty, tm) - 1;
    const [ly, lm] = fromMonthIndex(lastComplete);
    const fixed = detectRecurring(visibleTxs, ly, lm, recurringOptions);
    // The viewed month's incomes come from the live listener; the rest from the session read.
    const incomes = new Map(incomeHistory.map((row) => [row.id, row]));
    for (const row of incomeTransactions) incomes.set(row.id, row);
    return buildSavingsProfile({
      expenses: visibleTxs,
      incomes: [...incomes.values()],
      excludedExpenseCategories,
      excludedIncomeCategories,
      fixed,
      manualExpensesFor: (idx) => expenseTotalForMonth(additionalExpenses, ...fromMonthIndex(idx)),
      manualFixedMonthly: additionalExpenses
        .filter((e) => e.kind === "recurring" && e.monthKey <= ymKey(ly, lm))
        .reduce((sum, e) => sum + e.amount, 0),
      today,
    });
  }, [
    visibleTxs,
    incomeHistory,
    incomeTransactions,
    excludedExpenseCategories,
    excludedIncomeCategories,
    additionalExpenses,
    recurringOptions,
    today,
  ]);

  // Aggregate current-month spending per category — includes both detailed
  // credit-card rows and direct bank (עו״ש) rows, and defensively skips any
  // bank row that represents the lump-sum CC bill payment (those would
  // double-count the individual card purchases already in `transactions`).
  const { spending, totalSpent: txTotal, uncategorizedCount } = useMemo(
    () => aggregateBudgetSpending(monthRows, excludedExpenseCategories),
    [monthRows, excludedExpenseCategories],
  );
  // Manually-added (one-off / recurring) expenses are kept in their own
  // collection and added on top of the transaction-driven total.
  const totalSpent = txTotal + extraExpense;

  // Total average = sum of all category averages (for summary card)
  let totalAvg = 0;
  for (const avg of averages.values()) totalAvg += avg;

  const totalPct = totalAvg > 0 ? Math.min((totalSpent / totalAvg) * 100, 100) : 0;
  const totalOver = totalSpent > totalAvg;

  // When the cards are debited this month — shown until it happens.
  const billingDay = Math.min(settings.billingDay, daysInMonth(year, month));
  const cardsUpcoming = cycleStatus(year, month, today, settings.billingDay) === "upcoming";

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
            <Suspense fallback={<ChartFallback />}>
              {activeChart === "months" ? (
                <MonthlyTrend
                  allTransactions={visibleTxs}
                  year={year}
                  month={month}
                  excludedCategories={excludedExpenseCategories}
                />
              ) : (
                <CategoryBreakdown spending={spending} totalSpent={totalSpent} />
              )}
            </Suspense>
          </div>
        </div>
      )}

      {/* ── Bottom Line (Hero) ──────────────────────────────────── */}
      {!loadingAvg && (
        <BottomLine
          totalIncome={income.counted}
          internalTransfersIn={income.excluded}
          totalSpent={totalSpent}
          year={year}
          month={month}
        />
      )}

      {/* ── Smart Insights ────────────────────────────────────── */}
      {!loadingAvg && (
        <SmartInsights insights={insights} onShowUncategorized={onShowUncategorized} />
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
              : totalAvg > 0
                ? `חודש רגיל: ${Math.round(totalAvg).toLocaleString("he-IL")} ₪`
                : "אין עדיין חודשים קודמים להשוואה"}
          </span>
        </div>
        {/* Total progress bar */}
        <div className="h-2.5 rounded-full bg-red-950/60 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500 bg-white/30"
            style={{ width: `${totalPct}%` }}
          />
        </div>
        {totalAvg > 0 && (
          <div className="flex justify-between mt-2 text-xs text-white/50">
            <span>{totalPct.toFixed(0)}% מחודש רגיל</span>
            <span>
              {totalOver
                ? `חריגה של ${Math.round(totalSpent - totalAvg).toLocaleString("he-IL")} ₪`
                : `נותרו ${Math.round(totalAvg - totalSpent).toLocaleString("he-IL")} ₪`}
            </span>
          </div>
        )}
        {cardsUpcoming && (
          <p className="mt-2 text-[11px] text-white/60">
            חיובי האשראי של החודש ירדו מחשבון הבנק ב-{billingDay}/{month}.
          </p>
        )}

      </div>

      {/* ── Savings profile ─────────────────────────────────────── */}
      {!loadingAvg && <SavingsProfileCard profile={savingsProfile} />}

      {/* ── Savings Insights ────────────────────────────────────── */}
      {!loadingAvg && (
        <SavingsInsightsList
          recurringCharges={recurringCharges}
          allTransactions={visibleTxs}
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

      {/* ── Fixed charges ─────────────────────────────────────── */}
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
                ({recurringCharges.length}) · {Math.round(recurring.monthlyTotal).toLocaleString("he-IL")} ₪ לחודש
              </span>
            )}
          </div>

          {/* A charge that used to come every month and didn't */}
          {stoppedAlerts.length > 0 && (
            <div className="space-y-2 mb-3">
              {stoppedAlerts.map((alert) => (
                <div
                  key={alert.key}
                  className="flex items-start gap-3 rounded-2xl px-4 py-3 text-sm font-medium border bg-amber-50 dark:bg-amber-950/30 border-amber-200/60 dark:border-amber-800/40 text-amber-800 dark:text-amber-300"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <span>החיוב הקבוע של {alert.description} לא הגיע החודש — בוטל, או שהחיוב נכשל?</span>
                </div>
              ))}
            </div>
          )}

          {recurringCharges.length === 0 ? (
            <div className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-5 shadow-sm border border-slate-200/60 dark:border-slate-700/60 text-center">
              <p className="text-sm text-slate-400">
                לא זוהו חיובים קבועים החודש
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 leading-relaxed">
                מנוי או הוראת קבע מזוהים אחרי שני חיובים חודשיים באותו יום ובסכום דומה.
                אפשר גם לסמן עסקה כחיוב קבוע בלשונית ההוצאות.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {recurringCharges.map((charge) => {
                const pending = charge.status !== "charged";
                return (
                  <div
                    key={charge.id}
                    className={`flex items-center gap-3 rounded-2xl bg-white dark:bg-slate-900 px-4 py-3 shadow-sm border ${
                      pending ? "border-dashed border-slate-300 dark:border-slate-700" : "border-slate-200/60 dark:border-slate-700/60"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold truncate ${pending ? "text-slate-500 dark:text-slate-400" : "text-slate-800 dark:text-slate-100"}`}>
                        {charge.description}
                      </p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {FIXED_KIND_LABELS[charge.kind]}
                        {charge.installment && ` ${charge.installment.number}/${charge.installment.total}`}
                        {charge.cadence === 2 && " · דו-חודשי"}
                        {charge.original && (
                          <span dir="ltr"> · {charge.original.amount.toLocaleString("he-IL")} {charge.original.currency}</span>
                        )}
                        {charge.status === "expected" && ` · צפוי סביב ה-${charge.dayOfMonth} בחודש`}
                        {charge.status === "off-month" && " · החיוב הבא בחודש הבא"}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 text-sm font-bold tabular-nums ${pending ? "text-slate-400" : "text-slate-700 dark:text-slate-200"}`}
                      dir="ltr"
                    >
                      {Math.round(charge.amount).toLocaleString("he-IL")} ₪
                    </span>
                    {charge.kind !== "installment" && (
                      <button
                        onClick={() => markNotFixed(charge.key)}
                        className="shrink-0 p-1.5 -me-1.5 rounded-lg text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
                        aria-label={`${charge.description} אינו חיוב קבוע`}
                        title="זה לא חיוב קבוע — הסר מהרשימה"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {/* ── Bank / Credit Card Sync CTA ─────────────────────── */}
      {!loadingAvg && (
        <button
          onClick={() => setBankSyncOpen(true)}
          className="w-full flex items-center gap-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-700/60 px-4 py-3.5 mt-2 shadow-sm hover:shadow-md transition-all"
        >
          <div className="h-8 w-8 rounded-xl bg-teal-50 dark:bg-teal-900/40 flex items-center justify-center shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-teal-600" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-1 text-start">
            <p className="text-sm font-bold text-slate-800 dark:text-white">סנכרון חשבון בנק / אשראי</p>
            <p className="text-[11px] text-slate-400">ייבוא עסקאות אוטומטי ישירות מהבנק או מחברת האשראי</p>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-300 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </button>
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

      {/* ── Bank Sync Modal ─────────────────────────────────── */}
      {bankSyncOpen && <BankSyncModal onClose={() => setBankSyncOpen(false)} />}
    </section>
  );
}
