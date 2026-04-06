interface Props {
  totalIncome: number;
  totalSpent: number;
  year: number;
  month: number;
}

export default function BottomLine({
  totalIncome,
  totalSpent,
  year,
  month,
}: Props) {
  const income = totalIncome;

  // ── Calculations ────────────────────────────────────────────────
  const freeCash = income - totalSpent;

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
  const freePct = Math.max(100 - spentPct, 0);

  // ── No income uploaded ────────────────────────────────────────────
  if (income === 0) {
    return (
      <div className="rounded-2xl bg-white dark:bg-slate-900 border-2 border-dashed border-slate-200 dark:border-slate-700 p-6 mb-5 text-center">
        <p className="text-sm text-slate-500 mb-2">
          העלו דף עו״ש בלשונית ״הכנסות״ כדי לראות את השורה התחתונה
        </p>
      </div>
    );
  }

  return (
    <div className="mb-5">
      <div
        className={`rounded-2xl bg-gradient-to-bl ${heroColor} p-5 text-white shadow-lg ring-1 ring-black/5`}
      >
        {/* ── Income display ─────────────────────────────────── */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs text-white/70">
            הכנסה כוללת: {income.toLocaleString("he-IL")} ₪
          </span>
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
              <span className="inline-block w-2 h-2 rounded-full bg-white/15 border border-white/30" />
              פנוי ({Math.max(Math.round(freeCash), 0).toLocaleString("he-IL")})
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
