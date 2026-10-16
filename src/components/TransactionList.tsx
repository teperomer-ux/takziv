import { useState, useEffect, useCallback, useMemo } from "react";
import { Trash2, RefreshCw, X } from "lucide-react";
import type { Transaction, TransactionSource } from "../types";
import { useCategories } from "../hooks/useCategories";
import { isUncategorized, byUncategorizedThenDate } from "../utils/categoryStatus";
import { SOURCE_LABELS } from "../utils/bankReconciliation";
import {
  onAdditionalExpensesSnapshot,
  saveAdditionalExpense,
  deleteAdditionalExpense,
  type AdditionalExpense,
  type ExpenseKind,
} from "../services/additionalExpenseService";
import BankSyncModal from "./BankSyncModal";
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

/**
 * Light-background palette per provider. Each entry pairs a tinted surface
 * with the matching ink colour so the badge stays legible in dark mode.
 */
const SOURCE_BADGE_STYLES: Record<TransactionSource, string> = {
  max: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  isracard: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  cal: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  bank: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

function SourceBadge({ source }: { source: TransactionSource | undefined }) {
  if (!source) return null;
  return (
    <span
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md whitespace-nowrap ${SOURCE_BADGE_STYLES[source]}`}
      title={SOURCE_LABELS[source]}
    >
      {SOURCE_LABELS[source]}
    </span>
  );
}

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
  const [syncOpen, setSyncOpen] = useState(false);
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

  // ── CC-only guard ────────────────────────────────────────────────
  // This view is the "כרטיסי אשראי" tab — strictly credit-card rows.
  // The parent (`App.tsx`) already passes a pre-filtered slice, but we
  // re-apply the filter here so the component is self-protective: any
  // future call site that hands us the unfiltered union won't leak
  // עו״ש rows (source === "bank") into the CC list, its header count,
  // empty-state, or any downstream sum derived from this array.
  // Legacy rows (`source === undefined`) predate the field — they came
  // from the CC uploader before tagging existed, so they count as CC.
  const creditCardOnly = useMemo(
    () => transactions.filter((tx) => tx.source !== "bank"),
    [transactions],
  );

  const displayedTransactions = useMemo(() => {
    const base = filterUncategorized
      ? creditCardOnly.filter((tx) => isUncategorized(tx.category))
      : creditCardOnly;
    // Copy before sorting so we never mutate the parent array.
    // Uncategorized rows float to the top, newest date first within each group.
    return [...base].sort(byUncategorizedThenDate);
  }, [creditCardOnly, filterUncategorized]);

  if (creditCardOnly.length === 0) {
    return (
      <>
        <div className="rounded-2xl bg-white dark:bg-slate-900 p-8 text-center border border-slate-200/60 dark:border-slate-700/60">
          <p className="text-slate-400 mb-4">אין עסקאות להצגה.</p>
          <button
            onClick={() => setSyncOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary text-white px-5 py-2.5 text-sm font-semibold shadow-sm hover:bg-primary/90 transition-colors min-h-[44px]"
          >
            <RefreshCw className="h-4 w-4" />
            סנכרון חשבון בנק / אשראי
          </button>
        </div>
        {syncOpen && <BankSyncModal onClose={() => setSyncOpen(false)} />}
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

      {/* ── Month header with sync + delete buttons ───────────── */}
      <div className="flex items-center justify-between mb-4 px-1">
        <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
          הוצאות — {monthLabel} ({displayedTransactions.length}{filterUncategorized ? `/${creditCardOnly.length}` : ""})
        </h2>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setSyncOpen(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-primary transition-colors p-2.5 rounded-xl hover:bg-primary/5"
            aria-label="סנכרון חשבון בנק / אשראי"
            title="סנכרון חשבון בנק / אשראי"
          >
            <RefreshCw className="h-4 w-4" />
            <span className="hidden sm:inline">סנכרון</span>
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
            {/* Row 1: date + source badge + business name — read-only static text (not editable) */}
            <div className="flex items-baseline gap-2 mb-2 select-text">
              {/* Date is wrapped in its own LTR span so the digits keep their
                  left-to-right order even though the card is rendered RTL. */}
              <span
                className="shrink-0 text-xs sm:text-sm text-slate-500 dark:text-slate-400 tabular-nums cursor-default"
                dir="ltr"
              >
                {tx.date}
              </span>
              <SourceBadge source={tx.source} />
              <span
                className="flex-1 min-w-0 text-sm font-medium text-slate-800 dark:text-slate-200 break-words leading-snug cursor-default pointer-events-none"
              >
                {tx.description || "בית עסק"}
              </span>
            </div>

            {/* Row 2: status + amount + delete (right-aligned in RTL) */}
            <div className="flex items-center justify-end gap-2 mb-3">
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  tx.status === "confirmed"
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                {tx.status === "confirmed" ? "מאושר" : "טיוטה"}
              </span>
              <span className={`flex items-center gap-1 font-bold text-sm whitespace-nowrap tabular-nums ${
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

      {/* ── Bank Sync Modal ─────────────────────────────────────── */}
      {syncOpen && <BankSyncModal onClose={() => setSyncOpen(false)} />}

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
