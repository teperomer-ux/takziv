import { useState, useEffect, useCallback } from "react";
import { Trash2, Upload, X } from "lucide-react";
import type { Transaction } from "../types";
import { useCategories } from "../hooks/useCategories";
import {
  onAdditionalExpensesSnapshot,
  saveAdditionalExpense,
  deleteAdditionalExpense,
  type AdditionalExpense,
  type ExpenseKind,
} from "../services/additionalExpenseService";
import FileUploader from "./FileUploader";
import AddExpenseModal from "./AddExpenseModal";

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

interface Props {
  transactions: Transaction[];
  year: number;
  month: number;
  onUpdate: (id: string, field: keyof Omit<Transaction, "id">, value: string | number) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => Promise<number>;
  filterUncategorized?: boolean;
  onClearFilter?: () => void;
}

const ADD_NEW = "__add_new__";

export default function TransactionList({
  transactions,
  year,
  month,
  onUpdate,
  onDelete,
  onDeleteAll,
  filterUncategorized = false,
  onClearFilter,
}: Props) {
  const { categories, categoryNames, addCategory, addSubCategory } = useCategories();

  // Track which transaction is adding a new category/sub
  const [addingCatFor, setAddingCatFor] = useState<string | null>(null);
  const [addingSubFor, setAddingSubFor] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newSubName, setNewSubName] = useState("");

  // Delete-all-month state
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [expenseModalKind, setExpenseModalKind] = useState<ExpenseKind | null>(null);
  const [additionalExpenses, setAdditionalExpenses] = useState<AdditionalExpense[]>([]);

  // Subscribe to additional (manual) expenses
  useEffect(() => {
    return onAdditionalExpensesSnapshot(
      setAdditionalExpenses,
      (err) => console.warn("[TransactionList] additional expenses error:", err),
    );
  }, []);

  // Filter manual expenses for the viewed month
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const visibleManualExpenses = additionalExpenses.filter((exp) =>
    exp.kind === "one-time" ? exp.monthKey === monthKey : exp.monthKey <= monthKey,
  );

  const handleDeleteManualExpense = useCallback(async (id: string) => {
    try {
      await deleteAdditionalExpense(id);
      setToast("ההוצאה הוסרה");
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      console.error("[TransactionList] delete manual expense failed:", err);
    }
  }, []);

  const handleSaveExpense = useCallback(
    async (data: { description: string; amount: number; category: string; kind: ExpenseKind; monthKey: string }) => {
      try {
        await saveAdditionalExpense(data);
        setExpenseModalKind(null);
        setToast("ההוצאה נוספה בהצלחה");
        setTimeout(() => setToast(null), 2500);
      } catch (err) {
        console.error("[TransactionList] save expense failed:", err);
      }
    },
    [],
  );

  async function handleAddCategory(txId: string) {
    const trimmed = newCatName.trim();
    if (!trimmed) return;
    await addCategory(trimmed);
    onUpdate(txId, "category", trimmed);
    onUpdate(txId, "subCategory", "");
    setNewCatName("");
    setAddingCatFor(null);
  }

  async function handleAddSubCategory(txId: string, category: string) {
    const trimmed = newSubName.trim();
    if (!trimmed || !category) return;
    await addSubCategory(category, trimmed);
    onUpdate(txId, "subCategory", trimmed);
    setNewSubName("");
    setAddingSubFor(null);
  }

  async function handleDeleteMonth() {
    setDeleting(true);
    try {
      const count = await onDeleteAll();
      setConfirmDeleteAll(false);
      setToast(`${count} עסקאות נמחקו בהצלחה.`);
      setTimeout(() => setToast(null), 3000);
    } catch (err) {
      console.error("[TransactionList] delete month failed:", err);
      setToast("שגיאה במחיקת העסקאות.");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setDeleting(false);
    }
  }

  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;

  const displayedTransactions = (filterUncategorized
    ? transactions.filter((tx) => !tx.category)
    : [...transactions]
  ).sort((a, b) => {
    // Primary: uncategorized first
    const aUncat = !a.category ? 0 : 1;
    const bUncat = !b.category ? 0 : 1;
    if (aUncat !== bUncat) return aUncat - bUncat;
    // Secondary: newest date first
    return b.date.localeCompare(a.date);
  });

  if (transactions.length === 0) {
    return (
      <>
        <div className="rounded-2xl bg-white dark:bg-slate-900 p-8 text-center border border-slate-200/60 dark:border-slate-700/60">
          <p className="text-slate-400 mb-4">אין עסקאות להצגה.</p>
          <button
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary text-white px-5 py-2.5 text-sm font-semibold shadow-sm hover:bg-primary/90 transition-colors min-h-[44px]"
          >
            <Upload className="h-4 w-4" />
            העלאת קובץ חיובים
          </button>
        </div>
        {uploadOpen && (
          <UploadModal onClose={() => setUploadOpen(false)} billingMonth={month} billingYear={year} />
        )}
      </>
    );
  }

  return (
    <section>
      {/* ── Toast ─────────────────────────────────────────────── */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-slate-800 text-white px-4 py-2.5 text-sm shadow-lg animate-[fadeIn_0.2s_ease-out]">
          {toast}
        </div>
      )}

      {/* ── Month header with upload + delete buttons ─────────── */}
      <div className="flex items-center justify-between mb-4 px-1">
        <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
          הוצאות — {monthLabel} ({displayedTransactions.length}{filterUncategorized ? `/${transactions.length}` : ""})
        </h2>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setUploadOpen(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-primary transition-colors p-2.5 rounded-xl hover:bg-primary/5"
            aria-label="העלאת קובץ חיובים"
            title="העלאת קובץ חיובים"
          >
            <Upload className="h-4 w-4" />
            <span className="hidden sm:inline">העלאת קובץ</span>
          </button>

        {confirmDeleteAll ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleDeleteMonth}
              disabled={deleting}
              className="rounded-xl bg-rose-500 text-white px-4 py-2 text-xs font-semibold hover:bg-rose-600 transition-colors disabled:opacity-50 min-h-[36px]"
            >
              {deleting ? "מוחק..." : "אישור מחיקה"}
            </button>
            <button
              onClick={() => setConfirmDeleteAll(false)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 transition-colors min-h-[36px]"
            >
              ביטול
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDeleteAll(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-rose-500 transition-colors p-2.5 rounded-xl hover:bg-rose-50"
            aria-label="מחיקת כל העסקאות לחודש זה"
            title="מחיקת כל העסקאות לחודש זה"
          >
            <Trash2 className="h-4 w-4" />
            <span className="hidden sm:inline">מחק חודש</span>
          </button>
        )}
        </div>
      </div>

      {/* ── Add expense buttons ─────────────────────────────────── */}
      <div className="flex gap-2.5 mb-4">
        <button
          onClick={() => setExpenseModalKind("recurring")}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border border-teal-300 dark:border-teal-700 text-teal-700 dark:text-teal-400 px-3 py-2.5 text-xs font-semibold hover:bg-teal-50 dark:hover:bg-teal-950/30 active:scale-[0.98] transition-all min-h-[40px]"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
          </svg>
          הוצאה קבועה
        </button>
        <button
          onClick={() => setExpenseModalKind("one-time")}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border border-teal-300 dark:border-teal-700 text-teal-700 dark:text-teal-400 px-3 py-2.5 text-xs font-semibold hover:bg-teal-50 dark:hover:bg-teal-950/30 active:scale-[0.98] transition-all min-h-[40px]"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
          </svg>
          הוצאה חד פעמית
        </button>
      </div>

      {/* ── Filter banner ────────────────────────────────────────── */}
      {filterUncategorized && (
        <div className="flex items-center justify-between rounded-2xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-700/40 px-4 py-3 mb-4">
          <span className="text-sm text-blue-800 font-medium">
            מציג {displayedTransactions.length} עסקאות ללא סיווג
          </span>
          {onClearFilter && (
            <button
              onClick={onClearFilter}
              className="text-xs text-blue-600 font-semibold hover:text-blue-800 transition-colors px-2 py-1 rounded-lg hover:bg-blue-100"
            >
              הצג הכל
            </button>
          )}
        </div>
      )}

      {/* ── Confirmation banner ────────────────────────────────── */}
      {confirmDeleteAll && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200/60 px-4 py-3.5 mb-5 text-sm text-rose-700 font-medium">
          האם אתה בטוח שברצונך למחוק את כל העסקאות לחודש {monthLabel}? פעולה זו תמחוק את הנתונים לצמיתות.
        </div>
      )}

      <div className="space-y-3">
        {displayedTransactions.map((tx) => (
          <div
            key={tx.id}
            className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm border border-slate-200/60 dark:border-slate-700/60"
          >
            {/* Row 1: date, description, amount, status */}
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="w-[130px] shrink-0 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm inline-block"
                  dir="ltr"
                >
                  {tx.date}
                </span>
                <span
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm truncate inline-block"
                >
                  {tx.description || "בית עסק"}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                    tx.status === "confirmed"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {tx.status === "confirmed" ? "מאושר" : "טיוטה"}
                </span>
                <span className={`flex items-center gap-1 font-bold text-sm whitespace-nowrap ${
                  tx.amount < 0 ? "text-emerald-600" : "text-rose-600"
                }`}>
                  {tx.amount < 0 ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M12 7a1 1 0 01.707.293l3 3a1 1 0 01-1.414 1.414L13 10.414V17a1 1 0 11-2 0v-6.586l-1.293 1.293a1 1 0 01-1.414-1.414l3-3A1 1 0 0112 7z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M12 13a1 1 0 01-.707-.293l-3-3a1 1 0 011.414-1.414L11 9.586V3a1 1 0 112 0v6.586l1.293-1.293a1 1 0 011.414 1.414l-3 3A1 1 0 0112 13z" clipRule="evenodd" />
                    </svg>
                  )}
                  {tx.amount.toLocaleString("he-IL")} ₪
                </span>
                <button
                  onClick={() => onDelete(tx.id)}
                  className="text-slate-300 hover:text-danger transition-colors p-1"
                  aria-label="מחק עסקה"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {/* Row 2: category + sub-category dropdowns with "add new" */}
            <div className="flex gap-2">
              {/* ── Category select ──────────────────────────────── */}
              <div className="flex-1">
                {addingCatFor === tx.id ? (
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddCategory(tx.id);
                        if (e.key === "Escape") { setAddingCatFor(null); setNewCatName(""); }
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-primary bg-white px-2 py-1.5 text-sm"
                      placeholder="שם סעיף חדש..."
                      autoFocus
                    />
                    <button
                      onClick={() => handleAddCategory(tx.id)}
                      className="shrink-0 rounded-lg bg-primary text-white px-2 py-1.5 text-xs font-medium"
                    >
                      הוסף
                    </button>
                    <button
                      onClick={() => { setAddingCatFor(null); setNewCatName(""); }}
                      className="shrink-0 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-500"
                    >
                      ביטול
                    </button>
                  </div>
                ) : (
                  <select
                    value={tx.category}
                    onChange={(e) => {
                      if (e.target.value === ADD_NEW) {
                        setAddingCatFor(tx.id);
                        setNewCatName("");
                        return;
                      }
                      onUpdate(tx.id, "category", e.target.value);
                      const subs = categories[e.target.value];
                      onUpdate(tx.id, "subCategory", subs?.[0] ?? "");
                    }}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm appearance-none"
                  >
                    <option value="">סעיף</option>
                    {categoryNames.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                    <option value={ADD_NEW}>＋ הוסף סעיף חדש...</option>
                  </select>
                )}
              </div>

              {/* ── Sub-category select ──────────────────────────── */}
              <div className="flex-1">
                {addingSubFor === tx.id ? (
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={newSubName}
                      onChange={(e) => setNewSubName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddSubCategory(tx.id, tx.category);
                        if (e.key === "Escape") { setAddingSubFor(null); setNewSubName(""); }
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-primary bg-white px-2 py-1.5 text-sm"
                      placeholder="שם תת סעיף חדש..."
                      autoFocus
                    />
                    <button
                      onClick={() => handleAddSubCategory(tx.id, tx.category)}
                      className="shrink-0 rounded-lg bg-primary text-white px-2 py-1.5 text-xs font-medium"
                    >
                      הוסף
                    </button>
                    <button
                      onClick={() => { setAddingSubFor(null); setNewSubName(""); }}
                      className="shrink-0 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-500"
                    >
                      ביטול
                    </button>
                  </div>
                ) : (
                  <select
                    value={tx.subCategory}
                    onChange={(e) => {
                      if (e.target.value === ADD_NEW) {
                        if (!tx.category) return;
                        setAddingSubFor(tx.id);
                        setNewSubName("");
                        return;
                      }
                      onUpdate(tx.id, "subCategory", e.target.value);
                    }}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm appearance-none"
                  >
                    <option value="">תת סעיף</option>
                    {(categories[tx.category] ?? []).map((sub) => (
                      <option key={sub} value={sub}>
                        {sub}
                      </option>
                    ))}
                    {tx.category && (
                      <option value={ADD_NEW}>＋ הוסף תת סעיף...</option>
                    )}
                  </select>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Manual expenses ──────────────────────────────────────── */}
      {visibleManualExpenses.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 px-1">
            הוצאות ידניות
          </h3>
          <div className="space-y-2">
            {visibleManualExpenses.map((exp) => (
              <div
                key={exp.id}
                className="flex items-center gap-3 rounded-2xl bg-white dark:bg-slate-900 px-4 py-3 shadow-sm border border-slate-200/60 dark:border-slate-700/60"
              >
                <span className="text-rose-500 text-sm font-bold">−</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                    {exp.description}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {exp.kind === "recurring" ? "קבועה" : "חד פעמית"}
                    {exp.category ? ` · ${exp.category}` : ""}
                  </p>
                </div>
                <span className="text-sm font-semibold text-rose-600 dark:text-rose-400 shrink-0 tabular-nums">
                  {exp.amount.toLocaleString("he-IL")} ₪
                </span>
                <button
                  onClick={() => handleDeleteManualExpense(exp.id)}
                  className="p-1.5 rounded-lg text-slate-300 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                  aria-label="מחק הוצאה"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Upload Modal ────────────────────────────────────────── */}
      {uploadOpen && (
        <UploadModal onClose={() => setUploadOpen(false)} billingMonth={month} billingYear={year} />
      )}

      {/* ── Add Expense Modal ─────────────────────────────────── */}
      {expenseModalKind && (
        <AddExpenseModal
          kind={expenseModalKind}
          monthKey={`${year}-${String(month).padStart(2, "0")}`}
          categories={categoryNames.filter((c) => c !== "מקורות הכנסה")}
          onSave={handleSaveExpense}
          onClose={() => setExpenseModalKind(null)}
        />
      )}
    </section>
  );
}

// ── Upload Modal ────────────────────────────────────────────────────────

function UploadModal({ onClose, billingMonth, billingYear }: { onClose: () => void; billingMonth: number; billingYear: number }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-10 pb-4 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        dir="rtl"
        className="relative w-full max-w-2xl rounded-2xl bg-slate-100 dark:bg-slate-950 p-5 shadow-xl border border-slate-200/60 dark:border-slate-700/60"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">
            העלאת קובץ חיובים
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
            aria-label="סגור"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* FileUploader */}
        <FileUploader onDone={onClose} billingMonth={billingMonth} billingYear={billingYear} />
      </div>
    </div>
  );
}
