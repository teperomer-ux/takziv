import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { Settings, LogOut, Loader2, X } from "lucide-react";
import BottomNav, { type Tab } from "./components/BottomNav";
import Dashboard from "./components/Dashboard";
import TransactionList from "./components/TransactionList";
import IncomeList from "./components/IncomeList";
import SettingsModal from "./components/SettingsModal";
import BankSyncModal from "./components/BankSyncModal";
import Login from "./components/Login";
import { useTransactions } from "./hooks/useTransactions";
import { useIncomeTransactions } from "./hooks/useIncomeTransactions";
import { CategoriesContext, useCategoriesProvider } from "./hooks/useCategories";
import { IncomeCategoriesContext, useIncomeCategoriesProvider } from "./hooks/useIncomeCategories";
import { SettingsContext, useSettingsProvider } from "./hooks/useSettings";
import { BankSyncContext, useBankSyncProvider } from "./hooks/useBankSync";
import { institutionLabel } from "./constants/institutions";
import { useAuth } from "./hooks/useAuth";
import { getUidOrNull } from "./lib/firebase";
import { saveMapping, applyMappingToUncategorized } from "./services/mappingService";
import type { Transaction } from "./types";

type UpdateFn = (id: string, field: keyof Omit<Transaction, "id">, value: string | number) => void;
type CategoryPair = { category: string; subCategory: string };

/** How long a row's category must stay unchanged before the rule is applied to older rows. */
const BACKFILL_DELAY_MS = 1500;

/**
 * Wraps a list's update handler so that categorising a row also teaches the
 * classifier (users/{uid}/{colName}); the bank sync applies these mappings to
 * future imports, and existing uncategorised rows in txCollection with the
 * same description get the category too. Lists set category and subCategory
 * in back-to-back calls, so the latest pair per row is tracked locally
 * instead of read from props, and the backfill waits for the pair to settle.
 */
function useCategoryLearning(
  update: UpdateFn,
  rows: Transaction[],
  colName: string,
  txCollection: "transactions" | "incomeTransactions",
): UpdateFn {
  const latest = useRef(new Map<string, CategoryPair>());
  const backfillTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = backfillTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  return useCallback<UpdateFn>(
    (id, field, value) => {
      update(id, field, value);
      if (field !== "category" && field !== "subCategory") return;

      const tx = rows.find((t) => t.id === id);
      const uid = getUidOrNull();
      if (!tx || !uid) return;

      const base = latest.current.get(id) ?? { category: tx.category, subCategory: tx.subCategory };
      const next = { ...base, [field]: String(value) };
      latest.current.set(id, next);
      if (!next.category) return;

      saveMapping(uid, tx.description, next.category, next.subCategory, colName).catch((err) =>
        console.warn("[App] failed to learn category mapping:", err),
      );

      clearTimeout(backfillTimers.current.get(id));
      backfillTimers.current.set(
        id,
        setTimeout(() => {
          backfillTimers.current.delete(id);
          const settled = latest.current.get(id) ?? next;
          applyMappingToUncategorized(uid, txCollection, tx.description, settled.category, settled.subCategory, id)
            .then((count) => {
              if (count) console.info(`[App] auto-categorised ${count} earlier rows like "${tx.description}"`);
            })
            .catch((err) => console.warn("[App] failed to apply mapping to earlier rows:", err));
        }, BACKFILL_DELAY_MS),
      );
    },
    [update, rows, colName, txCollection],
  );
}

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

export default function App() {
  const { user, loading: authLoading, error: authError, signInWithGoogle, signOut } = useAuth();

  // ── Auth gate ─────────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 font-heebo">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-slate-400">טוען...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login error={authError} onSignIn={signInWithGoogle} />;
  }

  // Only mount data-fetching hooks AFTER auth is confirmed
  return <AuthenticatedApp signOut={signOut} />;
}

// ─── Inner component — only mounts when user is authenticated ───────────────
// This ensures every hook that subscribes to Firestore (useTransactions,
// useCategoriesProvider, useSettingsProvider, etc.) only runs AFTER
// auth.currentUser is set, so getUid() never throws.

function AuthenticatedApp({ signOut }: { signOut: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filterUncategorized, setFilterUncategorized] = useState(false);
  const { transactions, loading, error, update, remove, removeAll, setMonth, year, month } =
    useTransactions();
  const incomeTx = useIncomeTransactions();

  // ── Source split ──────────────────────────────────────────────
  // `transactions` is the union of synced card + עו״ש rows for the active
  // month. The three views consume strictly different slices:
  //
  //   • TransactionList ("כרטיסי אשראי")  → creditCardTransactions
  //   • IncomeList      ("עובר ושב")      → incomeTx + bankTransactions
  //   • Dashboard       ("ראשי")          → the full union (both combined)
  //
  // Legacy rows that predate `source` (undefined) count as credit-card —
  // they were imported by the former CC file uploader before the field existed.
  const creditCardTransactions = useMemo(
    () => transactions.filter((tx) => tx.source !== "bank"),
    [transactions],
  );
  const bankTransactions = useMemo(
    () => transactions.filter((tx) => tx.source === "bank"),
    [transactions],
  );

  const updateExpense = useCategoryLearning(update, transactions, "learnedMappings", "transactions");
  const updateIncome = useCategoryLearning(
    incomeTx.update,
    incomeTx.transactions,
    "learnedIncomeMappings",
    "incomeTransactions",
  );

  const categoriesCtx = useCategoriesProvider();
  const incomeCategoriesCtx = useIncomeCategoriesProvider();
  const settingsCtx = useSettingsProvider();
  const bankSync = useBankSyncProvider(settingsCtx.settings, settingsCtx.loading);
  const syncingConnection = bankSync.connections.find((c) => c.id === bankSync.syncingId);

  function prevMonth() {
    if (month === 1) { setMonth(year - 1, 12); incomeTx.setMonth(year - 1, 12); }
    else { setMonth(year, month - 1); incomeTx.setMonth(year, month - 1); }
  }

  function nextMonth() {
    if (month === 12) { setMonth(year + 1, 1); incomeTx.setMonth(year + 1, 1); }
    else { setMonth(year, month + 1); incomeTx.setMonth(year, month + 1); }
  }

  function handleShowUncategorized() {
    setFilterUncategorized(true);
    setTab("expenses");
  }

  return (
    <SettingsContext.Provider value={settingsCtx}>
    <BankSyncContext.Provider value={bankSync}>
    <CategoriesContext.Provider value={categoriesCtx}>
    <IncomeCategoriesContext.Provider value={incomeCategoriesCtx}>
    <div dir="rtl" className="min-h-screen bg-slate-100 dark:bg-slate-950 font-heebo pb-24 transition-colors">
      {/* ── Header ────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-gradient-to-l from-teal-700 to-teal-600 dark:from-slate-800 dark:to-slate-800 text-white px-5 py-4 shadow-lg">
        <div className="relative flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-xl font-bold tracking-wide">תקציב</h1>
            <p className="text-[11px] text-white/60 mt-0.5">ניהול הוצאות חכם</p>
          </div>
          {/* Background sync indicator — subtle, never blocks the screen */}
          {syncingConnection && (
            <button
              onClick={bankSync.openModal}
              className="absolute end-0 flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] text-white/85 hover:bg-white/15 transition-colors"
              role="status"
              aria-live="polite"
              title="סנכרון ברקע"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="hidden sm:inline">מסנכרן את {institutionLabel(syncingConnection.companyId)}…</span>
            </button>
          )}
          <div className="absolute start-0 flex items-center gap-0.5">
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2.5 rounded-xl hover:bg-white/15 transition-colors"
              aria-label="הגדרות"
            >
              <Settings className="h-5 w-5 text-white/80" />
            </button>
            <button
              onClick={signOut}
              className="p-2.5 rounded-xl hover:bg-white/15 transition-colors"
              aria-label="התנתק"
              title="התנתק"
            >
              <LogOut className="h-5 w-5 text-white/80" />
            </button>
          </div>
        </div>
      </header>

      {/* ── Content ───────────────────────────────────────────── */}
      <main className="mx-auto max-w-3xl px-4 py-5">
        {/* Month navigator */}
        <div className="flex items-center justify-between bg-white dark:bg-slate-900 rounded-2xl px-5 py-3 mb-5 shadow-sm border border-slate-200/60 dark:border-slate-700/60">
          {/* In RTL: first button renders on the RIGHT → previous month, arrow pointing right */}
          <button
            onClick={prevMonth}
            className="p-2 text-slate-400 hover:text-primary rounded-xl hover:bg-slate-50 transition-colors"
            aria-label="חודש קודם"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </button>
          <span className="font-bold text-slate-800 dark:text-slate-100 text-base">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          {/* In RTL: second button renders on the LEFT → next month, arrow pointing left */}
          <button
            onClick={nextMonth}
            className="p-2 text-slate-400 hover:text-primary rounded-xl hover:bg-slate-50 transition-colors"
            aria-label="חודש הבא"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Bank sync notice (background result / needs attention) */}
        {bankSync.notice && (
          <div
            role={bankSync.notice.kind === "success" ? "status" : "alert"}
            className={`mb-4 flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${
              bankSync.notice.kind === "success"
                ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200/70 dark:border-emerald-800/40 text-emerald-800 dark:text-emerald-300"
                : bankSync.notice.kind === "attention"
                  ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200/70 dark:border-amber-800/40 text-amber-800 dark:text-amber-300"
                  : "bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800/40 text-red-700 dark:text-red-400"
            }`}
          >
            <p className="flex-1 leading-relaxed">{bankSync.notice.text}</p>
            {bankSync.notice.kind === "attention" && (
              <button
                onClick={() => { bankSync.dismissNotice(); bankSync.openModal(); }}
                className="shrink-0 rounded-lg bg-amber-500 text-white px-3 py-1.5 text-xs font-semibold hover:bg-amber-600 transition-colors"
              >
                טיפול
              </button>
            )}
            <button
              onClick={bankSync.dismissNotice}
              className="shrink-0 p-1 rounded-lg opacity-60 hover:opacity-100 transition-opacity"
              aria-label="סגור הודעה"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 px-4 py-3 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            {tab === "dashboard" && (
              <Dashboard
                transactions={transactions}
                year={year}
                month={month}
                onShowUncategorized={handleShowUncategorized}
              />
            )}
            {tab === "expenses" && (
              <TransactionList
                transactions={creditCardTransactions}
                year={year}
                month={month}
                onUpdate={updateExpense}
                onDelete={remove}
                onDeleteAll={removeAll}
                filterUncategorized={filterUncategorized}
                onClearFilter={() => setFilterUncategorized(false)}
              />
            )}
            {tab === "incomes" && (
              <IncomeList
                transactions={incomeTx.transactions}
                bankTransactions={bankTransactions}
                onBankDelete={remove}
                onBankUpdate={updateExpense}
                year={year}
                month={month}
                onUpdate={updateIncome}
                onDelete={incomeTx.remove}
                onDeleteAll={incomeTx.removeAll}
              />
            )}
          </>
        )}
      </main>

      {/* ── Bottom Navigation ─────────────────────────────────── */}
      <BottomNav active={tab} onChange={(t) => { setTab(t); if (t !== "expenses") setFilterUncategorized(false); }} />

      {/* ── Settings Modal ────────────────────────────────────── */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* ── Bank sync modal opened from the header / notices ──── */}
      {bankSync.modalOpen && <BankSyncModal onClose={bankSync.closeModal} />}
    </div>
    </IncomeCategoriesContext.Provider>
    </CategoriesContext.Provider>
    </BankSyncContext.Provider>
    </SettingsContext.Provider>
  );
}
