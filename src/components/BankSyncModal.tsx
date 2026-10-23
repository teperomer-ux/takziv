import { useEffect, useState } from "react";
import { Check, Loader2, Plus, RefreshCw, AlertTriangle } from "lucide-react";
import {
  syncBankTransactions,
  BankSyncError,
  type BankConnection,
  type BankSyncErrorCode,
  type BankSyncResult,
} from "../services/bankSyncService";
import { useBankSync } from "../hooks/useBankSync";
import { useSettings } from "../hooks/useSettings";
import { INSTITUTIONS, findInstitution, type LoginField } from "../constants/institutions";
import { ERROR_MESSAGES, attentionReason } from "../constants/bankSyncMessages";
import type { TransactionSource } from "../types";

interface Props {
  onClose: () => void;
}

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

/** Same palette as the source badges in the expense list. */
const MARK_STYLES: Record<TransactionSource, string> = {
  max: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  isracard: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  cal: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  bank: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
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

/** "23/10/2026 14:05" */
function formatSyncTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inputClass =
  "w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-primary/40";
const labelClass = "text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 block";
const primaryButton =
  "rounded-xl bg-teal-600 text-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-teal-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]";
const secondaryButton =
  "rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[44px]";

type Phase =
  | { name: "form" }
  | { name: "loading" }
  | { name: "success"; result: BankSyncResult; remembered: boolean }
  | { name: "error"; code: BankSyncErrorCode };

export default function BankSyncModal({ onClose }: Props) {
  const { connections, connectionsLoaded, syncingId, syncNow, connect, disconnect } = useBankSync();
  const { settings, updateSettings } = useSettings();

  // null = decide from data: the accounts list when something is connected.
  const [view, setView] = useState<"list" | "form" | null>(null);
  const currentView = view ?? (connections.length > 0 ? "list" : "form");

  const [companyId, setCompanyId] = useState(INSTITUTIONS[0].id);
  const [values, setValues] = useState<Partial<Record<LoginField, string>>>({});
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [remember, setRemember] = useState(true);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [elapsed, setElapsed] = useState(0);

  const institution = findInstitution(companyId) ?? INSTITUTIONS[0];
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

  // Escape closes the modal, except mid-login (saved-connection syncs keep
  // running in the background, so they don't block closing).
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

  function openForm(preselect?: string) {
    if (preselect) selectInstitution(preselect);
    else setValues({});
    setPhase({ name: "form" });
    setView("form");
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
      const result = remember
        ? await connect(companyId, credentials, startDate)
        : await syncBankTransactions(companyId, credentials, startDate);
      setPhase({ name: "success", result, remembered: remember });
    } catch (err) {
      setPhase({ name: "error", code: err instanceof BankSyncError ? err.code : "INTERNAL_ERROR" });
    }
  }

  const title = currentView === "list" ? "חשבונות מחוברים" : "חיבור חשבון בנק / אשראי";

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
          {title}
        </h2>
        <p className="text-xs text-slate-400 mb-5">ייבוא אוטומטי של העסקאות ישירות מהבנק או מחברת האשראי</p>

        {/* ══ Connected accounts ═══════════════════════════════════ */}
        {currentView === "list" && (
          <div>
            {!connectionsLoaded && (
              <div className="flex justify-center py-6">
                <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
              </div>
            )}

            <div className="space-y-3">
              {connections.map((c) => (
                <ConnectionCard
                  key={c.id}
                  connection={c}
                  syncing={syncingId === c.id}
                  anotherSyncing={syncingId !== null && syncingId !== c.id}
                  onSync={() => syncNow(c.id)}
                  onUpdateCredentials={() => openForm(c.companyId)}
                  onDisconnect={() => disconnect(c.id)}
                />
              ))}
            </div>

            {syncingId && (
              <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
                הסנכרון ממשיך ברקע — אפשר לסגור את החלון ולהמשיך לעבוד.
              </p>
            )}

            {/* Auto-sync toggle */}
            <label className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 px-4 py-3 mt-5 cursor-pointer">
              <span>
                <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                  סנכרן אוטומטית בכניסה למערכת
                </span>
                <span className="block text-[11px] text-slate-400 mt-0.5">
                  בפתיחת האפליקציה, אם עברו יותר מ-24 שעות מהסנכרון האחרון
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.autoSyncOnStartup}
                onChange={(e) => updateSettings({ autoSyncOnStartup: e.target.checked })}
                className="h-5 w-9 shrink-0 appearance-none rounded-full bg-slate-300 dark:bg-slate-600 checked:bg-teal-600 relative cursor-pointer transition-colors before:absolute before:top-0.5 before:start-0.5 before:h-4 before:w-4 before:rounded-full before:bg-white before:transition-transform checked:before:-translate-x-4"
              />
            </label>

            <div className="flex gap-3 mt-5">
              <button type="button" onClick={() => openForm()} className={`flex-1 inline-flex items-center justify-center gap-1.5 ${secondaryButton}`}>
                <Plus className="h-4 w-4" />
                חיבור חשבון נוסף
              </button>
              <button type="button" onClick={onClose} className={`flex-1 ${primaryButton}`}>
                סגור
              </button>
            </div>
          </div>
        )}

        {/* ══ Connect / one-off sync form ══════════════════════════ */}
        {currentView === "form" && (
          <>
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
                  <Check className="h-6 w-6 text-emerald-600" />
                </div>
                <p className="text-base font-bold text-slate-800 dark:text-white">
                  {phase.result.savedCount > 0
                    ? `נוספו ${phase.result.savedCount.toLocaleString("he-IL")} עסקאות חדשות`
                    : "לא נמצאו עסקאות חדשות"}
                </p>
                <div className="text-xs text-slate-400 mt-2 space-y-0.5">
                  {phase.remembered && <p className="text-emerald-600 font-medium">{institution.label} מחובר — מעכשיו הסנכרון בלחיצה אחת.</p>}
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
                <div className="flex gap-3 mt-6">
                  {connections.length > 0 && (
                    <button type="button" onClick={() => setView("list")} className={`flex-1 ${secondaryButton}`}>
                      לחשבונות המחוברים
                    </button>
                  )}
                  <button type="button" onClick={onClose} className={`flex-1 ${primaryButton}`}>
                    סגור
                  </button>
                </div>
              </div>
            )}

            {/* ── Error ───────────────────────────────────────────── */}
            {phase.name === "error" && (
              <div className="py-2">
                <div role="alert" className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300 leading-relaxed">
                  {ERROR_MESSAGES[phase.code]}
                </div>
                <div className="flex gap-3 mt-6">
                  <button type="button" onClick={() => setPhase({ name: "form" })} className={`flex-1 ${primaryButton}`}>
                    נסה שוב
                  </button>
                  <button type="button" onClick={onClose} className={`flex-1 ${secondaryButton}`}>
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

                <label className="flex items-center gap-2 mb-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-200">שמור את החיבור לסנכרון בלחיצה אחת</span>
                </label>

                <p className="flex items-start gap-2 text-[11px] text-slate-400 leading-relaxed mb-5">
                  <svg className="h-3.5 w-3.5 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                  </svg>
                  {remember
                    ? "פרטי ההתחברות נשמרים מוצפנים בשרת הסנכרון, רק אם ההתחברות הצליחה, ולעולם אינם נשלחים חזרה לדפדפן."
                    : "פרטי ההתחברות נשלחים בחיבור מוצפן, משמשים לסנכרון הזה בלבד ואינם נשמרים."}
                </p>

                <div className="flex gap-3">
                  <button type="submit" disabled={!canSubmit} className={`flex-1 ${primaryButton}`}>
                    {remember ? "התחבר וסנכרן" : "סנכרן"}
                  </button>
                  <button
                    type="button"
                    onClick={connections.length > 0 ? () => setView("list") : onClose}
                    className={`flex-1 ${secondaryButton}`}
                  >
                    {connections.length > 0 ? "חזרה" : "ביטול"}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Connected account card ─────────────────────────────────────────────────

function ConnectionCard({
  connection,
  syncing,
  anotherSyncing,
  onSync,
  onUpdateCredentials,
  onDisconnect,
}: {
  connection: BankConnection;
  syncing: boolean;
  anotherSyncing: boolean;
  onSync: () => void;
  onUpdateCredentials: () => void;
  onDisconnect: () => void;
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const institution = findInstitution(connection.companyId);
  const needsAttention = connection.status === "needs_attention";
  const lastFailed = !needsAttention && connection.lastErrorCode;

  return (
    <div
      className={`rounded-2xl border p-4 ${
        needsAttention
          ? "border-amber-300/80 dark:border-amber-700/60 bg-amber-50/50 dark:bg-amber-950/20"
          : "border-slate-200/60 dark:border-slate-700/60"
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`h-10 w-10 shrink-0 rounded-xl flex items-center justify-center text-sm font-bold ${
            MARK_STYLES[institution?.source ?? "bank"]
          }`}
          aria-hidden="true"
        >
          {institution?.mark ?? "?"}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
            {institution?.label ?? connection.companyId}{" "}
            <span className="text-xs font-normal text-slate-400 tabular-nums" dir="ltr">{connection.maskedLogin}</span>
          </p>
          <p className="flex items-center gap-1.5 text-xs mt-0.5">
            <span className={`h-2 w-2 rounded-full ${needsAttention ? "bg-amber-500" : "bg-emerald-500"}`} />
            <span className={needsAttention ? "text-amber-700 dark:text-amber-400 font-semibold" : "text-emerald-700 dark:text-emerald-400"}>
              סטטוס: {needsAttention ? "נדרשת התערבות" : "מחובר"}
            </span>
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {connection.lastSyncAt ? (
              <>סונכרן לאחרונה: <span dir="ltr" className="tabular-nums">{formatSyncTime(connection.lastSyncAt)}</span></>
            ) : (
              "טרם סונכרן"
            )}
          </p>
        </div>
      </div>

      {needsAttention && (
        <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300 mt-3 leading-relaxed">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          {attentionReason(connection.lastErrorCode)}
        </p>
      )}
      {lastFailed && (
        <p className="text-[11px] text-rose-600 dark:text-rose-400 mt-2">
          הסנכרון האחרון נכשל: {ERROR_MESSAGES[connection.lastErrorCode as BankSyncErrorCode] ?? connection.lastErrorCode}
        </p>
      )}

      <div className="flex items-center gap-2 mt-3">
        {needsAttention ? (
          <button
            type="button"
            onClick={onUpdateCredentials}
            className="flex-1 rounded-xl bg-amber-500 text-white px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-amber-600 transition-colors min-h-[44px]"
          >
            עדכון פרטי התחברות
          </button>
        ) : (
          <button
            type="button"
            onClick={onSync}
            disabled={syncing || anotherSyncing}
            className={`flex-1 inline-flex items-center justify-center gap-2 ${primaryButton}`}
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {syncing ? "מסנכרן…" : "סנכרן עכשיו"}
          </button>
        )}
        {confirmDisconnect ? (
          <>
            <button
              type="button"
              onClick={onDisconnect}
              className="rounded-xl bg-rose-500 text-white px-3 py-2.5 text-xs font-semibold hover:bg-rose-600 transition-colors min-h-[44px]"
            >
              נתק
            </button>
            <button
              type="button"
              onClick={() => setConfirmDisconnect(false)}
              className="rounded-xl px-3 py-2.5 text-xs text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[44px]"
            >
              ביטול
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDisconnect(true)}
            disabled={syncing}
            className="rounded-xl px-3 py-2.5 text-xs text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors disabled:opacity-40 min-h-[44px]"
            title="מחיקת פרטי ההתחברות השמורים"
          >
            ניתוק
          </button>
        )}
      </div>
    </div>
  );
}
