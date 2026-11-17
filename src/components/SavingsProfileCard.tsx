import { LEVEL_LABELS, type ProfileLevel, type SavingsProfile } from "../utils/savingsProfile";

interface Props {
  profile: SavingsProfile;
}

const ils = (n: number) => `${Math.round(n).toLocaleString("he-IL")} ₪`;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

const LEVEL_STYLE: Record<ProfileLevel, { ring: string; badge: string }> = {
  excellent: { ring: "text-emerald-500", badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
  good: { ring: "text-teal-500", badge: "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300" },
  fair: { ring: "text-amber-500", badge: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  "at-risk": { ring: "text-rose-500", badge: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300" },
};

/** The savings profile: rate, fixed vs. variable, target and next steps (utils/savingsProfile.ts). */
export default function SavingsProfileCard({ profile }: Props) {
  const title = (
    <div className="flex items-center gap-2 mb-3 px-1">
      <span className="text-base leading-none" aria-hidden="true">🏦</span>
      <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">פרופיל חיסכון</h3>
    </div>
  );

  if (profile.status === "insufficient") {
    return (
      <div className="mb-5">
        {title}
        <div className="rounded-2xl bg-white dark:bg-slate-900 px-4 py-5 shadow-sm border border-slate-200/60 dark:border-slate-700/60 text-center">
          <p className="text-sm text-slate-500 dark:text-slate-400">עדיין אין מספיק נתונים לפרופיל חיסכון</p>
          <p className="text-[11px] text-slate-400 mt-1">
            {profile.monthsMissingIncome > 0
              ? "יש הוצאות, אבל אין הכנסות בחודשים שהסתיימו. סנכרנו את חשבון הבנק כדי להשלים אותן."
              : "נדרש לפחות חודש מלא אחד עם הכנסות והוצאות."}
          </p>
        </div>
      </div>
    );
  }

  const style = LEVEL_STYLE[profile.level];
  const deficit = profile.netSavings < 0;
  const fixedPct = Math.round(profile.fixedRatio * 100);
  // Circle gauge: r = 26 → circumference ≈ 163.4
  const circumference = 2 * Math.PI * 26;

  return (
    <div className="mb-5">
      {title}
      <div className="rounded-2xl bg-white dark:bg-slate-900 shadow-sm border border-slate-200/60 dark:border-slate-700/60 p-4">
        {/* Score + headline */}
        <div className="flex items-center gap-4">
          <div className="relative h-16 w-16 shrink-0" role="img" aria-label={`ציון ${profile.score} מתוך 100`}>
            <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
              <circle cx="32" cy="32" r="26" fill="none" strokeWidth="6" className="stroke-slate-100 dark:stroke-slate-800" />
              <circle
                cx="32"
                cy="32"
                r="26"
                fill="none"
                strokeWidth="6"
                strokeLinecap="round"
                stroke="currentColor"
                className={style.ring}
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - profile.score / 100)}
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-base font-extrabold text-slate-800 dark:text-slate-100 tabular-nums">
              {profile.score}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <span className={`inline-block text-[11px] font-bold px-2 py-0.5 rounded-full ${style.badge}`}>
              {LEVEL_LABELS[profile.level]}
            </span>
            <p className="text-sm text-slate-700 dark:text-slate-200 mt-1 leading-snug">
              {deficit ? (
                <>
                  גירעון ממוצע של <span className="font-bold text-rose-600 dark:text-rose-400 tabular-nums">{ils(-profile.netSavings)}</span> בחודש
                </>
              ) : (
                <>
                  חיסכון ממוצע של <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{ils(profile.netSavings)}</span> בחודש
                </>
              )}
            </p>
            <p className="text-[11px] text-slate-400">
              לפי {profile.monthsUsed === 1 ? "החודש המלא האחרון" : `${profile.monthsUsed} חודשים מלאים`}
              {profile.monthsMissingIncome > 0 && ` · ${profile.monthsMissingIncome} ללא נתוני הכנסה לא נכללו`}
            </p>
          </div>
        </div>

        {/* Key numbers */}
        <dl className="grid grid-cols-3 gap-2 mt-4 text-center">
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-2 py-2.5">
            <dt className="text-[10px] text-slate-400">שיעור חיסכון</dt>
            <dd className={`text-base font-bold tabular-nums ${deficit ? "text-rose-600 dark:text-rose-400" : "text-slate-800 dark:text-slate-100"}`} dir="ltr">
              {percent(profile.savingsRate)}
            </dd>
            <dd className="text-[10px] text-slate-400">יעד {percent(profile.targetRate)}</dd>
          </div>
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-2 py-2.5">
            <dt className="text-[10px] text-slate-400">הכנסה ממוצעת</dt>
            <dd className="text-base font-bold text-slate-800 dark:text-slate-100 tabular-nums">{ils(profile.avgIncome)}</dd>
            <dd className="text-[10px] text-slate-400">בחודש</dd>
          </div>
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-2 py-2.5">
            <dt className="text-[10px] text-slate-400">הוצאה ממוצעת</dt>
            <dd className="text-base font-bold text-slate-800 dark:text-slate-100 tabular-nums">{ils(profile.avgExpenses)}</dd>
            <dd className="text-[10px] text-slate-400">בחודש</dd>
          </div>
        </dl>

        {/* Fixed vs. variable */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 mb-1">
            <span>קבועות {ils(profile.fixedMonthly)} ({fixedPct}%)</span>
            <span>משתנות {ils(profile.variableMonthly)} ({100 - fixedPct}%)</span>
          </div>
          <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800" aria-hidden="true">
            <div className="bg-slate-500 dark:bg-slate-400" style={{ width: `${fixedPct}%` }} />
            <div className="bg-teal-400" style={{ width: `${100 - fixedPct}%` }} />
          </div>
        </div>

        {/* Projection */}
        {(profile.projection12 > 0 || profile.projection12WithCut > 0) && (
          <p className="mt-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            בקצב הנוכחי: <span className="font-semibold tabular-nums">{ils(profile.projection12)}</span> בשנה
            {profile.suggestedCut > 0 && (
              <>
                {" "}· עם קיצוץ של {ils(profile.suggestedCut)} בחודש:{" "}
                <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">{ils(profile.projection12WithCut)}</span>
              </>
            )}
          </p>
        )}

        {/* Tips */}
        {profile.tips.length > 0 && (
          <ul className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
            {profile.tips.map((tip) => (
              <li key={tip} className="flex gap-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
