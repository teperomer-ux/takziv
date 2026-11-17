import { useCallback, useMemo, useState } from "react";
import { Trash2, RefreshCw, Pencil, Search, X } from "lucide-react";
import type { Transaction } from "../types";
import { useIncomeCategories } from "../hooks/useIncomeCategories";
import BankSyncModal from "./BankSyncModal";
import ConfirmDialog from "./ConfirmDialog";
import { formatDate } from "../utils/formatDate";
import { isExcludedFromTotals, splitTotals } from "../utils/internalTransfers";

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

interface Props {
  /** The month's incomes — salaries, transfers in, refunds and other credits. */
  transactions: Transaction[];
  year: number;
  month: number;
  onUpdate: (id: string, field: keyof Omit<Transaction, "id">, value: string | number) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => Promise<number>;
}

const ADD_NEW = "__add_new__";
/** Filter value for rows that have no category yet. */
const UNCATEGORIZED = "__uncategorized__";
const UNCATEGORIZED_LABEL = "ללא סיווג";

const ils = (n: number) => `${Math.round(n).toLocaleString("he-IL")} ₪`;

export default function IncomeList({ transactions, year, month, onUpdate, onDelete, onDeleteAll }: Props) {
  const { categories, categoryNames, addCategory, addSubCategory, excludedCategories } = useIncomeCategories();

  const [addingCatFor, setAddingCatFor] = useState<string | null>(null);
  const [addingSubFor, setAddingSubFor] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newSubName, setNewSubName] = useState("");
  /** Income row whose date and description are open for editing. */
  const [editingId, setEditingId] = useState<string | null>(null);

  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  /** Income row waiting for the user to confirm its deletion. */
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  /** null = everything; a category name; or UNCATEGORIZED. */
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // ── Income metrics ────────────────────────────────────────────────
  // Operating income only: internal transfers (between own accounts, selling
  // securities, …) are money the user already had, reported beside it.
  const summary = useMemo(() => {
    const split = splitTotals(transactions, excludedCategories);
    const counted = transactions.filter((tx) => !isExcludedFromTotals(tx.category, excludedCategories));
    const byCategory = new Map<string, { total: number; count: number }>();
    for (const tx of counted) {
      const key = tx.category || UNCATEGORIZED;
      const entry = byCategory.get(key) ?? { total: 0, count: 0 };
      entry.total += tx.amount;
      entry.count++;
      byCategory.set(key, entry);
    }
    const breakdown = [...byCategory.entries()]
      .map(([key, v]) => ({ key, label: key === UNCATEGORIZED ? UNCATEGORIZED_LABEL : key, ...v }))
      .sort((a, b) => b.total - a.total);
    const largest = counted.reduce<Transaction | null>((top, tx) => (!top || tx.amount > top.amount ? tx : top), null);
    return { split, countedRows: counted.length, breakdown, largest };
  }, [transactions, excludedCategories]);

  const displayed = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (categoryFilter === UNCATEGORIZED ? tx.category !== "" : categoryFilter !== null && tx.category !== categoryFilter) {
        return false;
      }
      return !needle || tx.description.toLowerCase().includes(needle);
    });
  }, [transactions, categoryFilter, search]);
  const filtered = categoryFilter !== null || search.trim() !== "";
  const displayedTotal = useMemo(
    () => splitTotals(displayed, excludedCategories).counted,
    [displayed, excludedCategories],
  );

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

  if (transactions.length === 0) {
    return (
      <>
        <div className="rounded-2xl bg-white dark:bg-slate-900 p-8 text-center border border-slate-200/60 dark:border-slate-700/60">
          <p className="text-slate-500 dark:text-slate-400 mb-1">אין הכנסות ב{monthLabel}.</p>
          <p className="text-xs text-slate-400 mb-4">משכורות, העברות נכנסות וזיכויים מיובאים אוטומטית מחשבון הבנק.</p>
          <button
            onClick={() => setSyncOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 text-white px-5 py-2.5 text-sm font-semibold shadow-sm hover:bg-emerald-700 transition-colors min-h-[44px]"
          >
            <RefreshCw className="h-4 w-4" />
            סנכרון חשבון בנק
          </button>
        </div>
        {syncOpen && <BankSyncModal onClose={() => setSyncOpen(false)} />}
      </>
    );
  }

  const { split, breakdown, largest } = summary;

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
        <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">הכנסות — {monthLabel}</h2>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setSyncOpen(true)}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-emerald-600 transition-colors p-2.5 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
            aria-label="סנכרון חשבון בנק"
            title="סנכרון חשבון בנק"
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
                className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[36px]"
              >
                ביטול
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDeleteAll(true)}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-rose-500 transition-colors p-2.5 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/30"
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
        <div className="rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200/60 dark:border-rose-800/40 px-4 py-3.5 mb-5 text-sm text-rose-700 dark:text-rose-300 font-medium">
          האם אתה בטוח שברצונך למחוק את כל ההכנסות לחודש {monthLabel}? פעולה זו תמחוק את הנתונים לצמיתות.
        </div>
      )}

      {/* ── Summary cards ──────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-bl from-emerald-600 to-teal-700 dark:from-emerald-800 dark:to-teal-900 p-5 text-white shadow-lg mb-3">
        <p className="text-sm text-white/70 mb-1">סך ההכנסות ב{monthLabel}</p>
        <p className="text-3xl font-bold tracking-tight tabular-nums">{ils(split.counted)}</p>
        <p className="text-xs text-white/60 mt-1.5">
          {summary.countedRows} {summary.countedRows === 1 ? "הכנסה" : "הכנסות"} · {breakdown.length}{" "}
          {breakdown.length === 1 ? "מקור" : "מקורות"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-700/60 shadow-sm px-4 py-3">
          <p className="text-[11px] text-slate-400 mb-0.5">ההכנסה הגדולה</p>
          <p className="text-base font-bold text-slate-800 dark:text-slate-100 tabular-nums">{largest ? ils(largest.amount) : "—"}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{largest?.description || "—"}</p>
        </div>
        {split.uncategorized > 0 ? (
          <button
            onClick={() => setCategoryFilter(UNCATEGORIZED)}
            className="text-start rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 shadow-sm px-4 py-3 hover:bg-amber-100/60 dark:hover:bg-amber-950/50 transition-colors"
          >
            <p className="text-[11px] text-amber-700 dark:text-amber-400 mb-0.5">ממתינות לסיווג</p>
            <p className="text-base font-bold text-amber-800 dark:text-amber-300 tabular-nums">{ils(split.uncategorized)}</p>
            <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80">לחצו כדי לסווג</p>
          </button>
        ) : (
          <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-700/60 shadow-sm px-4 py-3">
            <p className="text-[11px] text-slate-400 mb-0.5">העברות פנימיות</p>
            <p className="text-base font-bold text-slate-800 dark:text-slate-100 tabular-nums">{ils(split.excluded)}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">לא נספרות כהכנסה</p>
          </div>
        )}
      </div>
      {split.uncategorized > 0 && split.excluded > 0 && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-2 mb-4 px-1">
          העברות פנימיות (לא נספרות כהכנסה): <span className="tabular-nums">{ils(split.excluded)}</span>
        </p>
      )}

      {/* ── Breakdown by source — tap a row to filter the list ─── */}
      {breakdown.length > 0 && split.counted > 0 && (
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-700/60 shadow-sm px-4 py-3.5 mb-4">
          <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-2.5">פילוח לפי מקור הכנסה</h3>
          <div className="space-y-2.5">
            {breakdown.map((row) => {
              const share = Math.max(0, Math.min(100, (row.total / split.counted) * 100));
              const active = categoryFilter === row.key;
              return (
                <button
                  key={row.key}
                  onClick={() => setCategoryFilter(active ? null : row.key)}
                  aria-pressed={active}
                  className={`block w-full text-start rounded-lg px-1.5 py-1 -mx-1.5 transition-colors ${
                    active ? "bg-emerald-50 dark:bg-emerald-950/30" : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className={`truncate font-medium ${row.key === UNCATEGORIZED ? "text-amber-700 dark:text-amber-400" : "text-slate-700 dark:text-slate-200"}`}>
                      {row.label}
                      <span className="text-[11px] font-normal text-slate-400"> · {row.count}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-700 dark:text-slate-200">
                      {ils(row.total)} <span className="text-[11px] text-slate-400">({Math.round(share)}%)</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${row.key === UNCATEGORIZED ? "bg-amber-400" : "bg-emerald-500"}`}
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Search + active filter ─────────────────────────────── */}
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-slate-400" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש לפי תיאור..."
          aria-label="חיפוש הכנסות לפי תיאור"
          className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-200 ps-9 pe-3 py-2.5 text-sm focus:outline-none focus:border-emerald-500"
        />
      </div>

      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
          {filtered ? `מוצגות ${displayed.length} מתוך ${transactions.length}` : `כל ההכנסות (${transactions.length})`}
          {filtered && displayed.length > 0 && <span className="font-medium tabular-nums"> · {ils(displayedTotal)}</span>}
        </h3>
        {filtered && (
          <button
            onClick={() => { setCategoryFilter(null); setSearch(""); }}
            className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            נקה סינון
          </button>
        )}
      </div>

      {displayed.length === 0 && (
        <p className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-700/60 px-4 py-6 text-center text-sm text-slate-400">
          אין הכנסות שתואמות את הסינון.
        </p>
      )}

      <div className="space-y-3">
        {displayed.map((tx) => {
          const excluded = isExcludedFromTotals(tx.category, excludedCategories);
          return (
          <div
            key={tx.id}
            dir="rtl"
            className={`rounded-2xl px-4 py-3 shadow-sm border space-y-2.5 ${
              excluded
                ? "bg-slate-50 dark:bg-slate-900/50 border-dashed border-slate-300 dark:border-slate-700"
                : "bg-white dark:bg-slate-900 border-slate-200/60 dark:border-slate-700/60"
            }`}
          >
            {/* Top line: date ↔ amount */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 tabular-nums" dir="ltr">
                {formatDate(tx.date)}
              </span>
              <span
                className={`font-bold text-sm whitespace-nowrap tabular-nums ${excluded ? "text-slate-400" : "text-emerald-600"}`}
                dir="ltr"
              >
                +{tx.amount.toLocaleString("he-IL")} ₪
              </span>
            </div>

            {/* Middle line: the full description, wrapped — never truncated */}
            {editingId === tx.id ? (
              <div className="space-y-2">
                <input
                  type="date"
                  value={tx.date}
                  onChange={(e) => onUpdate(tx.id, "date", e.target.value)}
                  aria-label="תאריך"
                  className="w-[150px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm"
                  dir="ltr"
                />
                <textarea
                  value={tx.description}
                  onChange={(e) => onUpdate(tx.id, "description", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  rows={Math.max(2, Math.ceil(tx.description.length / 40))}
                  aria-label="תיאור"
                  placeholder="תיאור"
                  className="block w-full resize-y rounded-lg border border-emerald-500 bg-white dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm leading-snug"
                  autoFocus
                />
                <div className="flex justify-end">
                  <button
                    onClick={() => setEditingId(null)}
                    className="rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-xs font-semibold hover:bg-emerald-700 transition-colors"
                  >
                    סיום
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm font-medium text-slate-800 dark:text-slate-200 whitespace-normal break-words leading-snug select-text">
                {tx.description || "הכנסה ללא תיאור"}
              </p>
            )}

            {/* Bottom line: classification, badge, actions */}
            <div className="flex flex-wrap items-center gap-2 pt-2.5 border-t border-slate-100 dark:border-slate-800">
              <div className="flex flex-1 min-w-[12rem] gap-2">
              <div className="flex-1 min-w-0">
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
                      className="min-w-0 flex-1 rounded-lg border border-emerald-500 bg-white dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm"
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
                      className="shrink-0 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-xs text-slate-500"
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
                    aria-label="מקור הכנסה"
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

              <div className="flex-1 min-w-0">
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
                      className="min-w-0 flex-1 rounded-lg border border-emerald-500 bg-white dark:bg-slate-800 dark:text-slate-200 px-2 py-1.5 text-sm"
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
                      className="shrink-0 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-xs text-slate-500"
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
                    aria-label="תת סעיף"
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

              <div className="flex items-center gap-1 ms-auto">
                {excluded && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md whitespace-nowrap bg-slate-200/70 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    לא נספר בהכנסות
                  </span>
                )}
                <button
                  onClick={() => setEditingId(editingId === tx.id ? null : tx.id)}
                  className="text-slate-300 hover:text-slate-500 dark:hover:text-slate-300 transition-colors p-1.5"
                  aria-label="ערוך תאריך ותיאור"
                  title="ערוך תאריך ותיאור"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setPendingDelete(tx)}
                  className="text-slate-300 hover:text-danger transition-colors p-1.5"
                  aria-label="מחק הכנסה"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {/* Bank Sync Modal */}
      {syncOpen && <BankSyncModal onClose={() => setSyncOpen(false)} />}
    </section>
  );
}
