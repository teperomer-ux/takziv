import { useState, useEffect } from "react";
import { Settings, LogOut } from "lucide-react";
import BottomNav, { type Tab } from "./components/BottomNav";
import Dashboard from "./components/Dashboard";
import FileUploader from "./components/FileUploader";
import TransactionList from "./components/TransactionList";
import SettingsModal from "./components/SettingsModal";
import Login from "./components/Login";
import { useTransactions } from "./hooks/useTransactions";
import { CategoriesContext, useCategoriesProvider } from "./hooks/useCategories";
import { SettingsContext, useSettingsProvider } from "./hooks/useSettings";
import { useAuth } from "./hooks/useAuth";

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

export default function App() {
  const { user, loading: authLoading, error: authError, signInWithGoogle, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { transactions, loading, error, update, remove, removeAll, setMonth, year, month } =
    useTransactions();
  const categoriesCtx = useCategoriesProvider();
  const settingsCtx = useSettingsProvider();

  // Apply theme class to <html>
  useEffect(() => {
    document.documentElement.classList.toggle("dark", settingsCtx.settings.theme === "dark");
  }, [settingsCtx.settings.theme]);

  // ── Auth gate ─────────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-50 font-heebo">
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

  function prevMonth() {
    if (month === 1) setMonth(year - 1, 12);
    else setMonth(year, month - 1);
  }

  function nextMonth() {
    if (month === 12) setMonth(year + 1, 1);
    else setMonth(year, month + 1);
  }

  return (
    <SettingsContext.Provider value={settingsCtx}>
    <CategoriesContext.Provider value={categoriesCtx}>
    <div dir="rtl" className="min-h-screen bg-slate-50 dark:bg-slate-900 font-heebo pb-20 transition-colors">
      {/* ── Header ────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-primary text-white px-4 py-3.5 shadow-md">
        <div className="relative flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-xl font-bold">תקציב</h1>
            <p className="text-xs text-white/70 mt-0.5">ניהול הוצאות חכם</p>
          </div>
          <div className="absolute start-0 flex items-center gap-1">
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-lg hover:bg-white/15 transition-colors"
              aria-label="הגדרות"
            >
              <Settings className="h-5 w-5 text-white/80" />
            </button>
            <button
              onClick={signOut}
              className="p-1.5 rounded-lg hover:bg-white/15 transition-colors"
              aria-label="התנתק"
              title="התנתק"
            >
              <LogOut className="h-4.5 w-4.5 text-white/80" />
            </button>
          </div>
        </div>
      </header>

      {/* ── Content ───────────────────────────────────────────── */}
      <main className="mx-auto max-w-3xl px-4 py-5">
        {/* Month navigator */}
        <div className="flex items-center justify-between bg-white dark:bg-slate-800 rounded-xl px-4 py-2.5 mb-4 shadow-sm border border-slate-100 dark:border-slate-700">
          <button
            onClick={prevMonth}
            className="p-1 text-slate-500 hover:text-primary transition-colors"
            aria-label="חודש קודם"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </button>
          <span className="font-semibold text-primary">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <button
            onClick={nextMonth}
            className="p-1 text-slate-500 hover:text-primary transition-colors"
            aria-label="חודש הבא"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
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
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
            {tab === "upload" && <FileUploader />}
            {tab === "history" && (
              <TransactionList
                transactions={transactions}
                year={year}
                month={month}
                onUpdate={update}
                onDelete={remove}
                onDeleteAll={removeAll}
              />
            )}
          </>
        )}
      </main>

      {/* ── Bottom Navigation ─────────────────────────────────── */}
      <BottomNav active={tab} onChange={setTab} />

      {/* ── Settings Modal ────────────────────────────────────── */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
    </CategoriesContext.Provider>
    </SettingsContext.Provider>
  );
}
