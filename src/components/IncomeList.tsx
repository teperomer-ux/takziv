import { useCallback, useState } from "react";
import { Trash2, RefreshCw } from "lucide-react";
import type { Transaction } from "../types";
import { useIncomeCategories } from "../hooks/useIncomeCategories";
import BankSyncModal from "./BankSyncModal";
import ConfirmDialog from "./ConfirmDialog";

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

interface Props {
  /** Incomes only — lives in its own Firestore collection. */
  transactions: Transaction[];
  /**
   * Direct bank (עו״ש) EXPENSES for the month — mortgage, fees, standing
   * orders, cash withdrawals, etc. They live in the shared transactions
   * collection (same as CC rows) but are filtered to this view so the CC
   * tab and the עו״ש tab don't double-list them.
   */
  bankTransactions: Transaction[];
  year: number;
  month: number;
  onUpdate: (id: string, field: keyof Omit<Transaction, "id">, value: string | number) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => Promise<number>;
  /** Delete a bank-side transaction. Bank rows live in the main transactions
   *  collection alongside CC rows, so this handler is the same one
   *  TransactionList uses — not the income-collection delete. */
  onBankDelete: (id: string) => void;
}

const ADD_NEW = "__add_new__";

export default function IncomeList({
  transactions,
  bankTransactions,
  year,
  month,
  onUpdate,
  onDelete,
  onDeleteAll,
  onBankDelete,
}: Props) {
  const { categories, categoryNames, addCategory, addSubCategory } = useIncomeCategories();

  const [addingCatFor, setAddingCatFor] = useState<string | null>(null);
  const [addingSubFor, setAddingSubFor] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newSubName, setNewSubName] = useState("");

  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  /** Income row waiting for the user to confirm its deletion. */
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  function confirmDelete() {
    if (pendingDelete) onDelete(pendingDelete.id);
    setPendingDelete(null);
  }

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
      setToast(`${count} הכנסות נמחקו בהצלחה.`);
      setTimeout(() => setToast(null), 3000);
    } catch (err) {
      console.error("[IncomeList] delete month failed:", err);
      setToast("שגיאה במחיקת ההכנסות.");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setDeleting(false);
    }
  }

  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;

  // Empty state only when the whole עו״ש tab has nothing — no incomes AND no
  // direct bank expenses. Otherwise we fall through and render whatever side
  // has data (e.g. mortgage-only months with no incoming salary yet).
  if (transactions.length === 0 && bankTransactions.length === 0) {
    return (
      <>
        <div className="rounded-2xl bg-white dark:bg-slate-900 p-8 text-center border border-slate-200/60 dark:border-slate-700/60">
          <p className="text-slate-400 mb-4">אין נתוני עו״ש להצגה.</p>
          <button
            onClick={() => setSyncOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 text-white px-5 py-2.5 text-sm font-semibold shadow-sm hover:bg-emerald-700 transition-colors min-h-[44px]"
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
      {pendingDelete && (
        <ConfirmDialog title="האם למחוק הכנסה זו?" confirmLabel="כן, מחק" onConfirm={confirmDelete} onCancel={cancelDelete}>
          {pendingDelete.description || "הכנסה ללא תיאור"} ·{" "}
          <span className="font-semibold text-emerald-600 whitespace-nowrap" dir="ltr">
            +{pendingDelete.amount.toLocaleString("he-IL")} ₪
          </span>
        </ConfirmDialog>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-slate-800 text-white px-4 py-2.5 text-sm shadow-lg animate-[fadeIn_0.2s_ease-out]">
          {toast}
        </div>
      )}

      {/* Month header */}
      <div className="flex items-center justify-between mb-4 px-1">
        <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
          הכנסות — {monthLabel} ({transactions.length})
        </h2>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setSyncOpen(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-600 transition-colors p-2.5 rounded-xl hover:bg-emerald-50"
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
              aria-label="מחיקת כל ההכנסות לחודש זה"
              title="מחיקת כל ההכנסות לחודש זה"
            >
              <Trash2 className="h-4 w-4" />
              <span className="hidden sm:inline">מחק חודש</span>
            </button>
          )}
        </div>
      </div>

      {/* Confirmation banner */}
      {confirmDeleteAll && (
        <div className="rounded-2xl bg-rose-50 border border-rose-200/60 px-4 py-3.5 mb-5 text-sm text-rose-700 font-medium">
          האם אתה בטוח שברצונך למחוק את כל ההכנסות לחודש {monthLabel}? פעולה זו תמחוק את הנתונים לצמיתות.
        </div>
      )}

      <div className="space-y-3">
        {transactions.map((tx) => (
          <div
            key={tx.id}
            className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm border border-slate-200/60 dark:border-slate-700/60"
          >
            {/* Row 1: date, description, amount */}
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-3 min-w-0">
                <input
                  type="date"
                  value={tx.date}
                  onChange={(e) => onUpdate(tx.id, "date", e.target.value)}
                  className="w-[130px] shrink-0 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm"
                  dir="ltr"
                />
                <input
                  type="text"
                  value={tx.description}
                  onChange={(e) => onUpdate(tx.id, "description", e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm"
                  placeholder="תיאור"
                />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-bold text-sm text-emerald-600 whitespace-nowrap">
                  +{tx.amount.toLocaleString("he-IL")} ₪
                </span>
                <button
                  onClick={() => setPendingDelete(tx)}
                  className="text-slate-300 hover:text-danger transition-colors p-1"
                  aria-label="מחק הכנסה"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Row 2: category + sub-category */}
            <div className="flex gap-2">
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
                      className="min-w-0 flex-1 rounded-lg border border-emerald-500 bg-white px-2 py-1.5 text-sm"
                      placeholder="שם סעיף חדש..."
                      autoFocus
                    />
                    <button
                      onClick={() => handleAddCategory(tx.id)}
                      className="shrink-0 rounded-lg bg-emerald-600 text-white px-2 py-1.5 text-xs font-medium"
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
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                    <option value={ADD_NEW}>+ הוסף סעיף חדש...</option>
                  </select>
                )}
              </div>

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
                      className="min-w-0 flex-1 rounded-lg border border-emerald-500 bg-white px-2 py-1.5 text-sm"
                      placeholder="שם תת סעיף חדש..."
                      autoFocus
                    />
                    <button
                      onClick={() => handleAddSubCategory(tx.id, tx.category)}
                      className="shrink-0 rounded-lg bg-emerald-600 text-white px-2 py-1.5 text-xs font-medium"
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
                      <option key={sub} value={sub}>{sub}</option>
                    ))}
                    {tx.category && <option value={ADD_NEW}>+ הוסף תת סעיף...</option>}
                  </select>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Bank-side expenses (עו״ש debits that aren't CC bill payments) ── */}
      {bankTransactions.length > 0 && (
        <BankExpensesSection
          transactions={bankTransactions}
          monthLabel={monthLabel}
          onDelete={onBankDelete}
        />
      )}

      {/* Bank Sync Modal */}
      {syncOpen && <BankSyncModal onClose={() => setSyncOpen(false)} />}
    </section>
  );
}

// ─── Bank-expenses section ───────────────────────────────────────────────────
// Lists every עו״ש debit row for the month — mortgage, fees, standing orders,
// cash withdrawals — strictly the rows whose `source === "bank"` and which
// passed the CC-bill filter in the parser. Renders below the incomes on the
// "עובר ושב" tab so all bank-side activity lives in one place. CC purchases
// never appear here; they have their own tab.

interface BankExpensesSectionProps {
  transactions: Transaction[];
  monthLabel: string;
  onDelete: (id: string) => void;
}

function BankExpensesSection({
  transactions,
  monthLabel,
  onDelete,
}: BankExpensesSectionProps) {
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);
  const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date));
  const total = sorted.reduce((s, tx) => s + tx.amount, 0);

  function confirmDelete() {
    if (pendingDelete) onDelete(pendingDelete.id);
    setPendingDelete(null);
  }

  return (
    <div className="mt-6">
      {pendingDelete && (
        <ConfirmDialog title="האם למחוק הוצאה זו?" confirmLabel="כן, מחק" onConfirm={confirmDelete} onCancel={cancelDelete}>
          {pendingDelete.description || "הוצאה ללא תיאור"} ·{" "}
          <span className="font-semibold text-rose-600 whitespace-nowrap" dir="ltr">
            −{pendingDelete.amount.toLocaleString("he-IL")} ₪
          </span>
        </ConfirmDialog>
      )}

      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-sm font-bold text-rose-700 dark:text-rose-400">
          הוצאות מהבנק — {monthLabel} ({sorted.length})
        </h3>
        <span className="text-xs font-semibold text-rose-600 dark:text-rose-400 tabular-nums" dir="ltr">
          {total.toLocaleString("he-IL")} ₪
        </span>
      </div>

      <div className="space-y-3">
        {sorted.map((tx) => (
          <div
            key={tx.id}
            className="rounded-2xl bg-white dark:bg-slate-900 p-4 shadow-sm border border-rose-200/60 dark:border-rose-900/40"
          >
            <div className="flex items-baseline gap-2 mb-2 select-text">
              <span
                className="shrink-0 text-xs sm:text-sm text-slate-500 dark:text-slate-400 tabular-nums"
                dir="ltr"
              >
                {tx.date}
              </span>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                בנק
              </span>
              <span className="flex-1 min-w-0 text-sm font-medium text-slate-800 dark:text-slate-200 break-words leading-snug">
                {tx.description || "—"}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">
                {tx.category || "ללא סעיף"}{tx.subCategory ? ` · ${tx.subCategory}` : ""}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-bold text-sm text-rose-600 tabular-nums" dir="ltr">
                  −{tx.amount.toLocaleString("he-IL")} ₪
                </span>
                <button
                  onClick={() => setPendingDelete(tx)}
                  className="text-slate-300 hover:text-danger transition-colors p-1"
                  aria-label="מחק הוצאה מהבנק"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
