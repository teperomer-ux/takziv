import { useSettings } from "../hooks/useSettings";

interface Props {
  totalSpent: number;
  expectedRecurring: number;
  year: number;
  month: number;
  onOpenSettings: () => void;
}

export default function BottomLine({
  totalSpent,
  expectedRecurring,
  year,
  month,
  onOpenSettings,
}: Props) {
  const { settings } = useSettings();
  const p1 = settings.partner1Income;
  const p2 = settings.partner2Income;
  const income = p1 + p2;

  // ── Calculations ────────────────────────────────────────────────
  const freeCash = income - totalSpent - expectedRecurring;

  const today = new Date();
  const isCurrentMonth =
    today.getFullYear() === year && today.getMonth() + 1 === month;
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysLeft = isCurrentMonth
    ? Math.max(daysInMonth - today.getDate(), 1)
    : daysInMonth;

  const dailyAllowance = daysLeft > 0 ? freeCash / daysLeft : 0;

  // ── Color logic ─────────────────────────────────────────────────
  const isWarning = freeCash > 0 && dailyAllowance <= 50;
  const isDanger = freeCash <= 0;

  const heroColor = isDanger
    ? "from-red-500 to-red-600"
    : isWarning
    ? "from-amber-500 to-orange-500"
    : "from-emerald-500 to-teal-600";

  const heroTextAccent = isDanger
    ? "text-red-100"
    : isWarning
    ? "text-amber-100"
    : "text-emerald-100";

  // ── Breakdown bar segments ──────────────────────────────────────
  const barBase = Math.max(income, 1);
  const spentPct = Math.min((totalSpent / barBase) * 100, 100);
  const recurPct = Math.min((expectedRecurring / barBase) * 100, 100 - spentPct);
  const freePct = Math.max(100 - spentPct - recurPct, 0);

  // Partner contribution %
  const p1Pct = income > 0 ? Math.round((p1 / income) * 100) : 0;
  const p2Pct = income > 0 ? 100 - p1Pct : 0;

  // ── No income set ───────────────────────────────────────────────
  if (income === 0) {
    return (
      <div className="rounded-xl bg-white border border-dashed border-slate-300 p-5 mb-5 text-center">
        <p className="text-sm text-slate-500 mb-3">
          הגדירו הכנסה חודשית כדי לראות את השורה התחתונה
        </p>
        <button
          onClick={onOpenSettings}
          className="rounded-lg bg-primary text-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-primary/90 transition-colors"
        >
          הגדרת הכנסה חודשית
        </button>
      </div>
    );
  }

  return (
    <div className="mb-5">
      <div
        className={`rounded-2xl bg-gradient-to-bl ${heroColor} p-5 text-white shadow-lg`}
      >
        {/* ── Income display ─────────────────────────────────── */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3 text-xs text-white/70">
            <span>
              הכנסה משותפת: {income.toLocaleString("he-IL")} ₪
            </span>
            {p1 > 0 && p2 > 0 && (
              <span className="text-[10px] text-white/50">
                ({p1Pct}% / {p2Pct}%)
              </span>
            )}
          </div>
          <button
            onClick={onOpenSettings}
            className="p-1 rounded-md hover:bg-white/15 transition-colors"
            aria-label="ערוך הכנסה"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5 text-white/60"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
          </button>
        </div>

        {/* The Bottom Line */}
        <p className={`text-xs ${heroTextAccent} mb-1`}>השורה התחתונה</p>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-4xl font-extrabold tracking-tight">
            {Math.round(freeCash).toLocaleString("he-IL")}
          </span>
          <span className="text-lg font-semibold">₪</span>
        </div>

        {/* Daily budget message */}
        <p className={`text-sm ${heroTextAccent} mb-4 leading-relaxed`}>
          {isCurrentMonth ? (
            <>
              נשארו{" "}
              <span className="font-bold text-white">{daysLeft}</span> ימים עד
              סוף החודש. התקציב היומי שלך הוא{" "}
              <span className="font-bold text-white">
                {Math.round(dailyAllowance).toLocaleString("he-IL")} ₪
              </span>{" "}
              ליום.
            </>
          ) : (
            <>
              תקציב יומי משוער:{" "}
              <span className="font-bold text-white">
                {Math.round(dailyAllowance).toLocaleString("he-IL")} ₪
              </span>{" "}
              ליום ({daysInMonth} ימים).
            </>
          )}
        </p>

        {/* ── Visual breakdown bar ───────────────────────────── */}
        <div className="space-y-2">
          <div className="flex h-3 rounded-full overflow-hidden bg-white/15">
            {spentPct > 0 && (
              <div
                className="bg-white/90 transition-all duration-500"
                style={{ width: `${spentPct}%` }}
                title={`הוצאות: ${Math.round(totalSpent).toLocaleString("he-IL")} ₪`}
              />
            )}
            {recurPct > 0 && (
              <div
                className="bg-white/40 transition-all duration-500"
                style={{ width: `${recurPct}%` }}
                title={`חיובים צפויים: ${Math.round(expectedRecurring).toLocaleString("he-IL")} ₪`}
              />
            )}
            {freePct > 0 && (
              <div
                className="transition-all duration-500"
                style={{ width: `${freePct}%` }}
              />
            )}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-[10px] text-white/70 flex-wrap">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-white/90" />
              הוצאות ({Math.round(totalSpent).toLocaleString("he-IL")})
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-white/40" />
              צפוי ({Math.round(expectedRecurring).toLocaleString("he-IL")})
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-white/15 border border-white/30" />
              פנוי ({Math.max(Math.round(freeCash), 0).toLocaleString("he-IL")})
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
