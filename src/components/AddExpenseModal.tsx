import { useState } from "react";
import type { ExpenseKind } from "../services/additionalExpenseService";

interface Props {
  kind: ExpenseKind;
  monthKey: string; // YYYY-MM of the currently viewed month
  categories: string[];
  onSave: (data: {
    description: string;
    amount: number;
    category: string;
    kind: ExpenseKind;
    monthKey: string;
  }) => void;
  onClose: () => void;
}

const MONTH_NAMES = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

function formatMonthLabel(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Format a number string with thousand separators while preserving decimals. */
function formatAmountDisplay(raw: string): string {
  // Strip everything except digits and a single dot
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const dotIdx = cleaned.indexOf(".");
  const intPart = dotIdx >= 0 ? cleaned.slice(0, dotIdx) : cleaned;
  const decPart = dotIdx >= 0 ? cleaned.slice(dotIdx) : "";
  // Add thousand separators to integer part
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return formatted + decPart;
}

/** Parse a formatted string back to a number. */
function parseAmount(display: string): number {
  return parseFloat(display.replace(/,/g, "")) || 0;
}

export default function AddExpenseModal({ kind, monthKey, categories, onSave, onClose }: Props) {
  const [description, setDescription] = useState("");
  const [amountDisplay, setAmountDisplay] = useState("");
  const [category, setCategory] = useState(categories[0] ?? "");

  const title = kind === "recurring" ? "הוצאה קבועה נוספת" : "הוצאה חד פעמית";
  const subtitle =
    kind === "recurring"
      ? `תחול מ-${formatMonthLabel(monthKey)} ואילך`
      : `עבור ${formatMonthLabel(monthKey)} בלבד`;

  const numericAmount = parseAmount(amountDisplay);
  const canSave = description.trim().length > 0 && numericAmount > 0 && category.length > 0;

  function handleAmountChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    // Allow only digits, commas, and a single dot
    if (/[^0-9.,]/.test(raw)) return;
    setAmountDisplay(formatAmountDisplay(raw));
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    onSave({
      description: description.trim(),
      amount: numericAmount,
      category,
      kind,
      monthKey,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <form
        onSubmit={handleSubmit}
        dir="rtl"
        className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-xl border border-slate-200/60 dark:border-slate-700/60"
      >
        <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-1">
          {title}
        </h2>
        <p className="text-xs text-slate-400 mb-5">{subtitle}</p>

        {/* Description */}
        <label className="block mb-4">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 block">
            תיאור
          </span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="לדוגמה: ביטוח רכב, חוג ילדים..."
            className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary/40"
            autoFocus
          />
        </label>

        {/* Amount */}
        <label className="block mb-4">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 block">
            סכום (₪)
          </span>
          <div className="relative">
            <span className="absolute start-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">₪</span>
            <input
              type="text"
              inputMode="decimal"
              value={amountDisplay}
              onChange={handleAmountChange}
              placeholder="0"
              className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ps-8 pe-3.5 py-2.5 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary/40"
              dir="ltr"
            />
          </div>
        </label>

        {/* Category */}
        <label className="block mb-6">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 block">
            קטגוריה
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </label>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={!canSave}
            className="flex-1 rounded-xl bg-teal-600 text-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-teal-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
          >
            שמור
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[44px]"
          >
            ביטול
          </button>
        </div>
      </form>
    </div>
  );
}
