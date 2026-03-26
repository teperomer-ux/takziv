import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { Transaction } from "../types";
import { useCategories } from "../hooks/useCategories";

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

export default function TransactionList({
  transactions,
  year,
  month,
  onUpdate,
  onDelete,
  onDeleteAll,
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

  if (transactions.length === 0) {
    return (
      <div className="rounded-xl bg-white p-8 text-center text-slate-400">
        אין עסקאות להצגה. העלו דף חיוב כדי להתחיל.
      </div>
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

      {/* ── Month header with delete button ───────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-primary">
          עסקאות — {monthLabel} ({transactions.length})
        </h2>

        {confirmDeleteAll ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleDeleteMonth}
              disabled={deleting}
              className="rounded-lg bg-red-500 text-white px-3 py-1.5 text-xs font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {deleting ? "מוחק..." : "אישור מחיקה"}
            </button>
            <button
              onClick={() => setConfirmDeleteAll(false)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors"
            >
              ביטול
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDeleteAll(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-500 transition-colors p-1.5 rounded-lg hover:bg-red-50"
            aria-label="מחיקת כל העסקאות לחודש זה"
            title="מחיקת כל העסקאות לחודש זה"
          >
            <Trash2 className="h-4 w-4" />
            <span className="hidden sm:inline">מחק חודש</span>
          </button>
        )}
      </div>

      {/* ── Confirmation banner ────────────────────────────────── */}
      {confirmDeleteAll && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 mb-4 text-sm text-red-700">
          האם אתה בטוח שברצונך למחוק את כל העסקאות לחודש {monthLabel}? פעולה זו תמחוק את הנתונים לצמיתות.
        </div>
      )}

      <div className="space-y-3">
        {transactions.map((tx) => (
          <div
            key={tx.id}
            className="rounded-xl bg-white p-4 shadow-sm border border-slate-100"
          >
            {/* Row 1: date, description, amount, status */}
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-3 min-w-0">
                <input
                  type="date"
                  value={tx.date}
                  onChange={(e) => onUpdate(tx.id, "date", e.target.value)}
                  className="w-[130px] shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
                  dir="ltr"
                />
                <input
                  type="text"
                  value={tx.description}
                  onChange={(e) =>
                    onUpdate(tx.id, "description", e.target.value)
                  }
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
                  placeholder="בית עסק"
                />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                    tx.status === "confirmed"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {tx.status === "confirmed" ? "מאושר" : "טיוטה"}
                </span>
                <span className={`flex items-center gap-1 font-semibold text-sm whitespace-nowrap ${
                  tx.amount < 0 ? "text-green-600" : "text-red-500"
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
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm appearance-none"
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
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm appearance-none"
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
    </section>
  );
}
