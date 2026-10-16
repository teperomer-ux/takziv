import { useEffect, useState } from "react";
import {
  syncBankTransactions,
  BankSyncError,
  type BankSyncErrorCode,
  type BankSyncResult,
} from "../services/bankSyncService";

interface Props {
  onClose: () => void;
}

type LoginField = "userCode" | "username" | "id" | "password" | "num" | "card6Digits";

interface Institution {
  id: string; // israeli-bank-scrapers companyId
  label: string;
  kind: "bank" | "card";
  fields: LoginField[];
}

// Field lists mirror SCRAPERS[companyId].loginFields in israeli-bank-scrapers.
const INSTITUTIONS: Institution[] = [
  { id: "hapoalim", label: "בנק הפועלים", kind: "bank", fields: ["userCode", "password"] },
  { id: "leumi", label: "בנק לאומי", kind: "bank", fields: ["username", "password"] },
  { id: "discount", label: "בנק דיסקונט", kind: "bank", fields: ["id", "password", "num"] },
  { id: "mizrahi", label: "בנק מזרחי טפחות", kind: "bank", fields: ["username", "password"] },
  { id: "max", label: "מקס", kind: "card", fields: ["username", "password"] },
  { id: "isracard", label: "ישראכרט", kind: "card", fields: ["id", "card6Digits", "password"] },
  { id: "visaCal", label: "כאל", kind: "card", fields: ["username", "password"] },
];

const FIELD_META: Record<LoginField, {
  label: string;
  type: "text" | "password";
  inputMode?: "numeric";
  maxLength?: number;
  autoComplete: string;
}> = {
  userCode: { label: "קוד משתמש", type: "text", autoComplete: "off" },
  username: { label: "שם משתמש", type: "text", autoComplete: "off" },
  id: { label: "תעודת זהות", type: "text", inputMode: "numeric", maxLength: 9, autoComplete: "off" },
  num: { label: "קוד מזהה", type: "text", autoComplete: "off" },
  card6Digits: { label: "6 ספרות אחרונות של הכרטיס", type: "text", inputMode: "numeric", maxLength: 6, autoComplete: "off" },
  password: { label: "סיסמה", type: "password", autoComplete: "new-password" },
};

const ERROR_MESSAGES: Record<BankSyncErrorCode, string> = {
  UNAUTHENTICATED: "פג תוקף ההתחברות לאפליקציה. התחברו מחדש ונסו שוב.",
  FORBIDDEN: "הסנכרון זמין רק למשתמשים שהתחברו עם Google.",
  INVALID_REQUEST: "חלק מהפרטים שהוזנו אינם תקינים. בדקו את הטופס ונסו שוב.",
  MISSING_CREDENTIAL_FIELDS: "חסרים פרטי התחברות. מלאו את כל השדות ונסו שוב.",
  SCRAPE_IN_PROGRESS: "סנכרון קודם עדיין פועל. המתינו לסיומו ונסו שוב.",
  SERVER_BUSY: "שרת הסנכרון עמוס כרגע. נסו שוב בעוד דקה.",
  BANK_INVALID_CREDENTIALS:
    "פרטי ההתחברות שגויים. בדקו אותם ונסו שוב — שימו לב שכמה ניסיונות כושלים ברצף עלולים לחסום את הגישה לחשבון.",
  BANK_OTP_REQUIRED: "הבנק דורש קוד חד-פעמי (OTP) בכניסה, ואפשרות זו עדיין לא נתמכת בסנכרון האוטומטי.",
  BANK_CHANGE_PASSWORD: "הבנק מבקש להחליף סיסמה. היכנסו לאתר הבנק, עדכנו את הסיסמה ונסו שוב.",
  BANK_ACCOUNT_BLOCKED: "הגישה לחשבון חסומה. פנו לבנק או לחברת האשראי כדי לשחרר את החסימה.",
  BANK_TIMEOUT: "אתר הבנק לא הגיב בזמן. נסו שוב בעוד כמה דקות.",
  BANK_ERROR: "אתר הבנק החזיר שגיאה לא צפויה. נסו שוב מאוחר יותר.",
  SAVE_FAILED: "העסקאות נמשכו אך השמירה נכשלה. אפשר לנסות שוב — עסקאות לא ישוכפלו.",
  INTERNAL_ERROR: "אירעה שגיאה בלתי צפויה. נסו שוב.",
  NETWORK_ERROR: "לא ניתן להתחבר לשרת הסנכרון. בדקו את החיבור לאינטרנט ונסו שוב.",
};

/** YYYY-MM-DD in local time. */
function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Default range: from the 1st of last month. */
function defaultStartDate(): string {
  const now = new Date();
  return ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

const inputClass =
  "w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary/40";
const labelClass = "text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 block";

type Phase =
  | { name: "form" }
  | { name: "loading" }
  | { name: "success"; result: BankSyncResult }
  | { name: "error"; code: BankSyncErrorCode };

export default function BankSyncModal({ onClose }: Props) {
  const [companyId, setCompanyId] = useState(INSTITUTIONS[0].id);
  const [values, setValues] = useState<Partial<Record<LoginField, string>>>({});
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [elapsed, setElapsed] = useState(0);

  const institution = INSTITUTIONS.find((i) => i.id === companyId) ?? INSTITUTIONS[0];
  const loading = phase.name === "loading";
  const canSubmit =
    institution.fields.every((f) => (values[f] ?? "").trim().length > 0) && startDate.length > 0;

  // Seconds counter shown under the spinner.
  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  // Escape closes the modal, except mid-sync.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, onClose]);

  function selectInstitution(id: string) {
    setCompanyId(id);
    setValues({}); // never carry credentials over to another institution
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || loading) return;

    const credentials: Record<string, string> = {};
    for (const f of institution.fields) credentials[f] = (values[f] ?? "").trim();
    // Credentials live only in this call from here on — wipe them from state.
    setValues({});
    setPhase({ name: "loading" });

    try {
      const result = await syncBankTransactions(companyId, credentials, startDate);
      setPhase({ name: "success", result });
    } catch (err) {
      setPhase({ name: "error", code: err instanceof BankSyncError ? err.code : "INTERNAL_ERROR" });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />

      <div
        dir="rtl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bank-sync-title"
        className="relative w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-xl border border-slate-200/60 dark:border-slate-700/60"
      >
        <h2 id="bank-sync-title" className="text-lg font-bold text-slate-800 dark:text-white mb-1">
          סנכרון חשבון בנק / אשראי
        </h2>
        <p className="text-xs text-slate-400 mb-5">ייבוא אוטומטי של העסקאות ישירות מהבנק או מחברת האשראי</p>

        {/* ── Loading ─────────────────────────────────────────── */}
        {loading && (
          <div className="flex flex-col items-center text-center py-6" role="status" aria-live="polite">
            <svg className="h-10 w-10 animate-spin text-teal-600 mb-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              מתחברים ל{institution.label} ומושכים עסקאות…
            </p>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              התהליך נמשך בדרך כלל 30–60 שניות.
              <br />
              אנא אל תסגרו את החלון.
            </p>
            <p className="text-xs text-slate-400 mt-3 tabular-nums" dir="ltr">{elapsed}s</p>
          </div>
        )}

        {/* ── Success ─────────────────────────────────────────── */}
        {phase.name === "success" && (
          <div className="text-center py-4" role="status">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
              <svg className="h-6 w-6 text-emerald-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-base font-bold text-slate-800 dark:text-white">
              {phase.result.savedCount > 0
                ? `נוספו ${phase.result.savedCount.toLocaleString("he-IL")} עסקאות חדשות`
                : "לא נמצאו עסקאות חדשות"}
            </p>
            <div className="text-xs text-slate-400 mt-2 space-y-0.5">
              {phase.result.savedIncomeCount > 0 && (
                <p>
                  {phase.result.savedExpenseCount} הוצאות ו-{phase.result.savedIncomeCount} הכנסות
                </p>
              )}
              {phase.result.skippedCardPaymentCount > 0 && (
                <p>{phase.result.skippedCardPaymentCount} חיובי כרטיסי אשראי דולגו — סנכרנו את הכרטיס עצמו לפירוט</p>
              )}
              {phase.result.duplicateCount > 0 && (
                <p>{phase.result.duplicateCount} עסקאות כבר היו קיימות ולא שוכפלו</p>
              )}
              {phase.result.skippedPendingCount > 0 && (
                <p>{phase.result.skippedPendingCount} עסקאות בהמתנה ייובאו לאחר שייקלטו סופית</p>
              )}
              {phase.result.savedCount > 0 && <p>העסקאות נשמרו כטיוטה — מומלץ לעבור על הסיווג.</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 w-full rounded-xl bg-teal-600 text-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-teal-700 transition-colors min-h-[44px]"
            >
              סגור
            </button>
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────── */}
        {phase.name === "error" && (
          <div className="py-2">
            <div role="alert" className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300 leading-relaxed">
              {ERROR_MESSAGES[phase.code]}
            </div>
            <div className="flex gap-3 mt-6">
              <button
                type="button"
                onClick={() => setPhase({ name: "form" })}
                className="flex-1 rounded-xl bg-teal-600 text-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-teal-700 transition-colors min-h-[44px]"
              >
                נסה שוב
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[44px]"
              >
                סגור
              </button>
            </div>
          </div>
        )}

        {/* ── Form ────────────────────────────────────────────── */}
        {phase.name === "form" && (
          <form onSubmit={handleSubmit} autoComplete="off">
            <label className="block mb-4">
              <span className={labelClass}>בנק / חברת אשראי</span>
              <select value={companyId} onChange={(e) => selectInstitution(e.target.value)} className={inputClass}>
                <optgroup label="בנקים">
                  {INSTITUTIONS.filter((i) => i.kind === "bank").map((i) => (
                    <option key={i.id} value={i.id}>{i.label}</option>
                  ))}
                </optgroup>
                <optgroup label="כרטיסי אשראי">
                  {INSTITUTIONS.filter((i) => i.kind === "card").map((i) => (
                    <option key={i.id} value={i.id}>{i.label}</option>
                  ))}
                </optgroup>
              </select>
            </label>

            {institution.fields.map((field, idx) => {
              const meta = FIELD_META[field];
              return (
                <label key={`${companyId}-${field}`} className="block mb-4">
                  <span className={labelClass}>{meta.label}</span>
                  <input
                    type={meta.type}
                    inputMode={meta.inputMode}
                    maxLength={meta.maxLength}
                    autoComplete={meta.autoComplete}
                    value={values[field] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                    className={inputClass}
                    dir="ltr"
                    autoFocus={idx === 0}
                    spellCheck={false}
                  />
                </label>
              );
            })}

            <label className="block mb-4">
              <span className={labelClass}>ייבוא עסקאות החל מתאריך</span>
              <input
                type="date"
                value={startDate}
                max={ymd(new Date())}
                onChange={(e) => setStartDate(e.target.value)}
                className={inputClass}
              />
            </label>

            <p className="flex items-start gap-2 text-[11px] text-slate-400 leading-relaxed mb-5">
              <svg className="h-3.5 w-3.5 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              פרטי ההתחברות נשלחים בחיבור מוצפן, משמשים לסנכרון הזה בלבד ואינם נשמרים.
            </p>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={!canSubmit}
                className="flex-1 rounded-xl bg-teal-600 text-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-teal-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
              >
                סנכרן
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
        )}
      </div>
    </div>
  );
}
