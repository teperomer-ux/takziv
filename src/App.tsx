import { useState } from "react";
import { Settings, LogOut } from "lucide-react";
import BottomNav, { type Tab } from "./components/BottomNav";
import Dashboard from "./components/Dashboard";
import TransactionList from "./components/TransactionList";
import IncomeList from "./components/IncomeList";
import SettingsModal from "./components/SettingsModal";
import Login from "./components/Login";
import { useTransactions } from "./hooks/useTransactions";
import { useIncomeTransactions } from "./hooks/useIncomeTransactions";
import { CategoriesContext, useCategoriesProvider } from "./hooks/useCategories";
import { IncomeCategoriesContext, useIncomeCategoriesProvider } from "./hooks/useIncomeCategories";
import { SettingsContext, useSettingsProvider } from "./hooks/useSettings";
import { useAuth } from "./hooks/useAuth";

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
  const categoriesCtx = useCategoriesProvider();
  const incomeCategoriesCtx = useIncomeCategoriesProvider();
  const settingsCtx = useSettingsProvider();

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
                transactions={transactions}
                year={year}
                month={month}
                onUpdate={update}
                onDelete={remove}
                onDeleteAll={removeAll}
                filterUncategorized={filterUncategorized}
                onClearFilter={() => setFilterUncategorized(false)}
              />
            )}
            {tab === "incomes" && (
              <IncomeList
                transactions={incomeTx.transactions}
                year={year}
                month={month}
                onUpdate={incomeTx.update}
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
    </div>
    </IncomeCategoriesContext.Provider>
    </CategoriesContext.Provider>
    </SettingsContext.Provider>
  );
}
