import { useState } from "react";
import { Trash2, Upload, X } from "lucide-react";
import type { Transaction } from "../types";
import { useIncomeCategories } from "../hooks/useIncomeCategories";
import IncomeUploader from "./IncomeUploader";

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
}

const ADD_NEW = "__add_new__";

export default function IncomeList({
  transactions,
  year,
  month,
  onUpdate,
  onDelete,
  onDeleteAll,
}: Props) {
  const { categories, categoryNames, addCategory, addSubCategory } = useIncomeCategories();

  const [addingCatFor, setAddingCatFor] = useState<string | null>(null);
  const [addingSubFor, setAddingSubFor] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newSubName, setNewSubName] = useState("");

  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

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

  if (transactions.length === 0) {
    return (
      <>
        <div className="rounded-2xl bg-white dark:bg-slate-900 p-8 text-center border border-slate-200/60 dark:border-slate-700/60">
          <p className="text-slate-400 mb-4">אין הכנסות להצגה.</p>
          <button
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 text-white px-5 py-2.5 text-sm font-semibold shadow-sm hover:bg-emerald-700 transition-colors min-h-[44px]"
          >
            <Upload className="h-4 w-4" />
            העלאת דף עו״ש
          </button>
        </div>
        {uploadOpen && (
          <IncomeUploadModal year={year} month={month} onClose={() => setUploadOpen(false)} />
        )}
      </>
    );
  }

  return (
    <section>
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
            onClick={() => setUploadOpen(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-600 transition-colors p-2.5 rounded-xl hover:bg-emerald-50"
            aria-label="העלאת דף עו״ש"
            title="העלאת דף עו״ש"
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
                  onClick={() => onDelete(tx.id)}
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

      {/* Upload Modal */}
      {uploadOpen && (
        <IncomeUploadModal year={year} month={month} onClose={() => setUploadOpen(false)} />
      )}
    </section>
  );
}

// ── Upload Modal ────────────────────────────────────────────────────────

function IncomeUploadModal({ year, month, onClose }: { year: number; month: number; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-10 pb-4 overflow-y-auto">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        dir="rtl"
        className="relative w-full max-w-2xl rounded-2xl bg-slate-100 dark:bg-slate-950 p-5 shadow-xl border border-slate-200/60 dark:border-slate-700/60"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">
            העלאת דף עו״ש — הכנסות
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
            aria-label="סגור"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <IncomeUploader year={year} month={month} onDone={onClose} />
      </div>
    </div>
  );
}
