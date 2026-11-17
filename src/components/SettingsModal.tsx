import { useState, useEffect } from "react";
import {
  X,
  Grid3X3,
  ShieldCheck,
  Landmark,
  CalendarClock,
  Trash2,
  Pencil,
  Plus,
  ChevronDown,
  ChevronLeft,
  Wand2,
  RefreshCw,
  Sun,
  Moon,
  Repeat,
} from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import { useCategories } from "../hooks/useCategories";
import { useBankSync } from "../hooks/useBankSync";
import { clearAllMappings } from "../services/mappingService";
import { reapplyRulesToHistory, type ReclassifyResult } from "../services/reclassifyService";
import { connectionState, type ConnectionState } from "../services/bankSyncService";
import type { CardCompany } from "../services/settingsService";
import { CONNECTION_STATE_LABELS } from "../constants/bankSyncMessages";
import { institutionLabel } from "../constants/institutions";
import { COMMON_BILLING_DAYS, MAX_BILLING_DAY, type DefaultMonthView } from "../utils/billingCycle";
import { auth } from "../lib/firebase";
import {
  getFinancialProfile,
  saveFinancialProfile,
} from "../services/userProfileService";
import {
  BANKS,
  CREDIT_CARDS,
  DEFAULT_FINANCIAL_PROFILE,
  getAvailableClubs,
  getAvailableWallets,
  type UserFinancialProfile,
  type FinancialOption,
} from "../types/userProfile";

interface Props {
  open: boolean;
  onClose: () => void;
}

type TabKey = "accounts" | "billing" | "categories" | "data";

const TABS: { key: TabKey; label: string; icon: typeof Grid3X3 }[] = [
  { key: "accounts", label: "חשבונות וסנכרון", icon: Landmark },
  { key: "billing", label: "תקציב ומחזור חיוב", icon: CalendarClock },
  { key: "categories", label: "קטגוריות וחיובים קבועים", icon: Grid3X3 },
  { key: "data", label: "נתונים ופרטיות", icon: ShieldCheck },
];

const SECTION_TITLE = "text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1";
const SECTION_HINT = "text-xs text-slate-500 dark:text-slate-400 leading-relaxed";
const SELECT =
  "rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:border-primary";

export default function SettingsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>("accounts");
  const { settings, updateSettings } = useSettings();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const dark = settings.theme === "dark";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 pb-10" role="dialog" aria-modal="true" aria-label="הגדרות">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">הגדרות</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => updateSettings({ theme: dark ? "light" : "dark" })}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-400"
              aria-label={dark ? "מעבר למראה בהיר" : "מעבר למראה כהה"}
              title={dark ? "מראה בהיר" : "מראה כהה"}
            >
              {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-400"
              aria-label="סגור הגדרות"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Sections */}
        <div className="flex border-b border-slate-100 dark:border-slate-700 px-2 overflow-x-auto scrollbar-hide" role="tablist">
          {TABS.map((t, i) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {i + 1}. {t.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === "accounts" && <AccountsTab onClose={onClose} />}
          {tab === "billing" && <BillingTab />}
          {tab === "categories" && (
            <div className="space-y-6">
              <FixedChargesSection />
              <CategoriesTab />
            </div>
          )}
          {tab === "data" && <DataTab />}
        </div>
      </div>
    </div>
  );
}

// ─── 1. Accounts & sync ────────────────────────────────────────────────────

const STATE_DOT: Record<ConnectionState, string> = {
  syncing: "bg-sky-500 animate-pulse",
  sync_incomplete: "bg-amber-500",
  active: "bg-emerald-500",
  unstable: "bg-amber-500",
  session_expired: "bg-amber-500",
  reauth_required: "bg-rose-500",
};

function formatSyncTime(iso: string): string {
  return new Date(iso).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

function AccountsTab({ onClose }: { onClose: () => void }) {
  const { connections, syncingId, isQueued, openModal } = useBankSync();
  const { settings, updateSettings } = useSettings();
  const [profileOpen, setProfileOpen] = useState(false);

  const rows = connections.map((c) => ({ c, state: connectionState(c, c.id === syncingId) }));
  const needAttention = rows.filter((r) => r.state === "reauth_required" || r.state === "session_expired").length;
  const lastSync = connections.reduce<string | null>(
    (latest, c) => (c.lastSyncAt && (!latest || c.lastSyncAt > latest) ? c.lastSyncAt : latest),
    null,
  );

  function openSync() {
    onClose();
    openModal();
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className={SECTION_TITLE}>סנכרון חשבונות בנק ואשראי</h3>
        <p className={`${SECTION_HINT} mb-3`}>
          {connections.length === 0
            ? "עדיין לא חוברו חשבונות. חיבור חשבון בנק או כרטיס אשראי מייבא את התנועות אוטומטית."
            : `${connections.length === 1 ? "חשבון אחד מחובר" : `${connections.length} חשבונות מחוברים`}` +
              (lastSync ? ` · סנכרון אחרון: ${formatSyncTime(lastSync)}` : " · טרם סונכרנו") +
              (needAttention > 0 ? ` · ${needAttention === 1 ? "אחד דורש" : `${needAttention} דורשים`} טיפול` : "")}
        </p>

        {rows.length > 0 && (
          <ul className="mb-3 divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200/70 dark:border-slate-700">
            {rows.map(({ c, state }) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden="true" />
                <span className="flex-1 min-w-0 text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                  {institutionLabel(c.companyId)}
                </span>
                <span className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">
                  {isQueued(c) ? "ממתין בתור" : CONNECTION_STATE_LABELS[state].label}
                </span>
              </li>
            ))}
          </ul>
        )}

        <button
          onClick={openSync}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary text-white px-4 py-3 text-sm font-bold shadow-sm hover:bg-primary/90 active:scale-[0.99] transition-all min-h-[44px]"
        >
          <RefreshCw className="h-4 w-4" />
          {connections.length === 0 ? "חיבור חשבון בנק או כרטיס אשראי" : "סנכרון וניהול חשבונות"}
        </button>
      </section>

      <section>
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span>
            <span className="block text-sm font-semibold text-slate-700 dark:text-slate-200">סנכרון אוטומטי</span>
            <span className={`block ${SECTION_HINT} mt-0.5`}>
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
      </section>

      <section className="border-t border-slate-100 dark:border-slate-800 pt-4">
        <button
          onClick={() => setProfileOpen((v) => !v)}
          aria-expanded={profileOpen}
          className="w-full flex items-center justify-between gap-2 text-start"
        >
          <span>
            <span className="block text-sm font-semibold text-slate-700 dark:text-slate-200">הבנקים, הכרטיסים והמועדונים שלי</span>
            <span className={`block ${SECTION_HINT} mt-0.5`}>משמש להתאמת המלצות החיסכון להטבות שמגיעות לכם</span>
          </span>
          {profileOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronLeft className="h-4 w-4 text-slate-400" />}
        </button>
        {profileOpen && (
          <div className="mt-4">
            <FinancialProfileTab />
          </div>
        )}
      </section>
    </div>
  );
}

// ─── 2. Budget & billing cycle ─────────────────────────────────────────────

const ALL_DAYS = Array.from({ length: MAX_BILLING_DAY }, (_, i) => i + 1);
const CARD_COMPANIES: { id: CardCompany; label: string }[] = [
  { id: "max", label: "מקס" },
  { id: "isracard", label: "ישראכרט" },
  { id: "cal", label: "כאל" },
];
const MONTH_VIEWS: { id: DefaultMonthView; label: string; hint: string }[] = [
  { id: "current", label: "החודש הנוכחי", hint: "המחזור הפעיל, כולל מה שעוד מצטבר" },
  { id: "previous", label: "החודש הקודם", hint: "חודש שהסתיים — כל החיובים כבר ירדו" },
];

function BillingTab() {
  const { settings, updateSettings } = useSettings();
  const overrides = settings.billingDayBySource;

  function setOverride(company: CardCompany, value: string) {
    const next = { ...overrides };
    if (value === "") delete next[company];
    else next[company] = Number(value);
    updateSettings({ billingDayBySource: next });
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className={SECTION_TITLE}>יום חיוב בכרטיס האשראי</h3>
        <p className={`${SECTION_HINT} mb-3`}>
          היום בחודש שבו חברת האשראי מורידה את החיוב מחשבון הבנק. לפיו האפליקציה יודעת מתי מחזור החיוב של החודש כבר ירד.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {COMMON_BILLING_DAYS.map((day) => {
            const active = settings.billingDay === day;
            return (
              <button
                key={day}
                onClick={() => updateSettings({ billingDay: day })}
                aria-pressed={active}
                className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
                  active
                    ? "bg-primary text-white border-primary"
                    : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600 hover:border-slate-300"
                }`}
              >
                {day} בחודש
              </button>
            );
          })}
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            יום אחר:
            <select
              value={settings.billingDay}
              onChange={(e) => updateSettings({ billingDay: Number(e.target.value) })}
              className={SELECT}
              aria-label="יום חיוב חודשי"
            >
              {ALL_DAYS.map((day) => (
                <option key={day} value={day}>{day}</option>
              ))}
            </select>
          </label>
        </div>

        <details className="mt-4 group">
          <summary className="cursor-pointer text-xs font-medium text-primary select-none">
            יום חיוב שונה לחברת אשראי מסוימת
          </summary>
          <div className="mt-3 space-y-2">
            {CARD_COMPANIES.map((company) => (
              <label key={company.id} className="flex items-center justify-between gap-3 text-sm text-slate-700 dark:text-slate-200">
                {company.label}
                <select
                  value={overrides[company.id] ?? ""}
                  onChange={(e) => setOverride(company.id, e.target.value)}
                  className={SELECT}
                >
                  <option value="">כמו הכללי ({settings.billingDay})</option>
                  {ALL_DAYS.map((day) => (
                    <option key={day} value={day}>{day} בחודש</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </details>
      </section>

      <section>
        <h3 className={SECTION_TITLE}>איזה חודש להציג בפתיחה</h3>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {MONTH_VIEWS.map((view) => {
            const active = settings.defaultMonthView === view.id;
            return (
              <button
                key={view.id}
                onClick={() => updateSettings({ defaultMonthView: view.id })}
                aria-pressed={active}
                className={`text-start rounded-xl border-2 p-3 transition-colors ${
                  active
                    ? "border-primary bg-primary/5 dark:bg-primary/10"
                    : "border-slate-200 dark:border-slate-600 hover:border-slate-300"
                }`}
              >
                <span className="block text-sm font-semibold text-slate-700 dark:text-slate-200">{view.label}</span>
                <span className="block text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{view.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-4 py-3">
        <h3 className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">איך נספרים חיובי האשראי</h3>
        <p className={SECTION_HINT}>
          רכישה בכרטיס נספרת בחודש שבו היא מחויבת, לא בחודש שבו נקנתה. חיובים של חודש שעוד לא התחיל (למשל חיובי דצמבר
          כשעדיין נובמבר) מוסתרים ואינם נכנסים לסיכומים, לממוצעים, לתובנות או לחיובים הקבועים — עד שהחודש שלהם מגיע.
        </p>
      </section>
    </div>
  );
}

// ─── 3a. Fixed charges: the user's own markings ────────────────────────────

function FixedChargesSection() {
  const { settings, updateSettings } = useSettings();
  const lists: { title: string; empty: string; field: "fixedMerchants" | "notFixedMerchants" }[] = [
    {
      title: "סומנו כחיוב קבוע",
      empty: "לא סומנו עסקים. בלשונית ההוצאות, לחצו על סמל החיצים ליד עסקה כדי לסמן אותה כחיוב קבוע.",
      field: "fixedMerchants",
    },
    {
      title: "הוסרו מהחיובים הקבועים",
      empty: "לא הוסרו עסקים. הסרה נעשית ב-✕ ליד חיוב ברשימת החיובים הקבועים במסך הראשי.",
      field: "notFixedMerchants",
    },
  ];

  return (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <Repeat className="h-4 w-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">חיובים קבועים</h3>
      </div>
      <p className={`${SECTION_HINT} mb-3`}>
        מנויים והוראות קבע מזוהים אוטומטית: חיוב אחד בחודש, באותו יום בערך ובסכום דומה. קניות חוזרות בסופר, במסעדות
        או בתחנת דלק אינן חיוב קבוע. הסימון שלכם תמיד גובר על הזיהוי.
      </p>
      <div className="space-y-3">
        {lists.map(({ title, empty, field }) => (
          <div key={field}>
            <h4 className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-1.5">
              {title} ({settings[field].length})
            </h4>
            {settings[field].length === 0 ? (
              <p className="text-[11px] text-slate-400 leading-relaxed">{empty}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {settings[field].map((key) => (
                  <li
                    key={key}
                    className="flex items-center gap-1 rounded-full border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 ps-3 pe-1 py-1 text-xs text-slate-700 dark:text-slate-200"
                  >
                    <span className="max-w-[12rem] truncate">{key}</span>
                    <button
                      onClick={() => updateSettings({ [field]: settings[field].filter((k) => k !== key) })}
                      className="p-0.5 rounded-full text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
                      aria-label={`בטל סימון של ${key}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── 3b. Categories ────────────────────────────────────────────────────────

function CategoriesTab() {
  const {
    categories,
    categoryNames,
    addCategory,
    addSubCategory,
    deleteCategory,
    removeSubCategory,
    renameCategory,
    excludedCategories,
    setCategoryExcluded,
  } = useCategories();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [addingCat, setAddingCat] = useState(false);
  const [addingSubFor, setAddingSubFor] = useState<string | null>(null);
  const [newSubName, setNewSubName] = useState("");
  const [editingCat, setEditingCat] = useState<string | null>(null);
  const [editCatDraft, setEditCatDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function handleAddCat() {
    const trimmed = newCatName.trim();
    if (!trimmed) return;
    await addCategory(trimmed);
    setNewCatName("");
    setAddingCat(false);
  }

  async function handleAddSub(cat: string) {
    const trimmed = newSubName.trim();
    if (!trimmed) return;
    await addSubCategory(cat, trimmed);
    setNewSubName("");
    setAddingSubFor(null);
  }

  async function handleRenameCat(oldName: string) {
    const trimmed = editCatDraft.trim();
    if (!trimmed || trimmed === oldName) {
      setEditingCat(null);
      return;
    }
    await renameCategory(oldName, trimmed);
    setEditingCat(null);
    if (expanded === oldName) setExpanded(trimmed);
  }

  async function handleDeleteCat(name: string) {
    await deleteCategory(name);
    setConfirmDelete(null);
    if (expanded === name) setExpanded(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          סעיפי הוצאה <span className="font-normal text-slate-400">({categoryNames.length})</span>
        </h3>
        <button
          onClick={() => { setAddingCat(true); setNewCatName(""); }}
          className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          סעיף חדש
        </button>
      </div>

      {addingCat && (
        <div className="flex gap-2">
          <input
            type="text"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddCat();
              if (e.key === "Escape") setAddingCat(false);
            }}
            className="min-w-0 flex-1 rounded-lg border border-primary bg-white dark:bg-slate-800 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none"
            placeholder="שם סעיף חדש..."
            autoFocus
          />
          <button
            onClick={handleAddCat}
            className="rounded-lg bg-primary text-white px-3 py-2 text-xs font-medium"
          >
            הוסף
          </button>
          <button
            onClick={() => setAddingCat(false)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500"
          >
            ביטול
          </button>
        </div>
      )}

      <div className="space-y-1">
        {categoryNames.map((cat) => {
          const subs = categories[cat] ?? [];
          const isExpanded = expanded === cat;
          const isEditing = editingCat === cat;
          const isDeleting = confirmDelete === cat;

          return (
            <div
              key={cat}
              className="rounded-xl border border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800/60 overflow-hidden"
            >
              {/* Category row */}
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  onClick={() => setExpanded(isExpanded ? null : cat)}
                  className="p-0.5 text-slate-400"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronLeft className="h-4 w-4" />
                  )}
                </button>

                {isEditing ? (
                  <input
                    type="text"
                    value={editCatDraft}
                    onChange={(e) => setEditCatDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameCat(cat);
                      if (e.key === "Escape") setEditingCat(null);
                    }}
                    onBlur={() => handleRenameCat(cat)}
                    className="min-w-0 flex-1 rounded border border-primary bg-white dark:bg-slate-800 dark:text-slate-100 px-2 py-0.5 text-sm focus:outline-none"
                    autoFocus
                  />
                ) : (
                  <span
                    className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-200 cursor-pointer"
                    onClick={() => setExpanded(isExpanded ? null : cat)}
                  >
                    {cat}
                  </span>
                )}

                <span className="text-[10px] text-slate-400">
                  {subs.length}
                </span>

                {!isEditing && (
                  <button
                    onClick={() => {
                      setEditingCat(cat);
                      setEditCatDraft(cat);
                    }}
                    className="p-1 text-slate-300 hover:text-slate-500 transition-colors"
                    aria-label="שנה שם"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}

                {isDeleting ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDeleteCat(cat)}
                      className="rounded bg-red-500 text-white px-2 py-0.5 text-[10px] font-medium"
                    >
                      מחק
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="rounded border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500"
                    >
                      ביטול
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(cat)}
                    className="p-1 text-slate-300 hover:text-red-400 transition-colors"
                    aria-label="מחק סעיף"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>

              {/* Sub-categories */}
              {isExpanded && (
                <div className="border-t border-slate-50 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/40 px-3 py-2 space-y-1">
                  {/* Internal transfers (buying securities, deposits) are not spending */}
                  <label className="flex items-center gap-2 py-1 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={excludedCategories.has(cat)}
                      onChange={(e) => setCategoryExcluded(cat, e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300 accent-primary"
                    />
                    לא לספור בסך ההוצאות (העברה פנימית)
                  </label>
                  {subs.length === 0 && (
                    <p className="text-xs text-slate-400 py-1">אין תת סעיפים</p>
                  )}
                  {subs.map((sub) => (
                    <div
                      key={sub}
                      className="flex items-center justify-between py-1 pe-1"
                    >
                      <span className="text-xs text-slate-600 dark:text-slate-300">{sub}</span>
                      <button
                        onClick={() => removeSubCategory(cat, sub)}
                        className="p-0.5 text-slate-300 hover:text-red-400 transition-colors"
                        aria-label={`מחק ${sub}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}

                  {addingSubFor === cat ? (
                    <div className="flex gap-1 pt-1">
                      <input
                        type="text"
                        value={newSubName}
                        onChange={(e) => setNewSubName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAddSub(cat);
                          if (e.key === "Escape") setAddingSubFor(null);
                        }}
                        className="min-w-0 flex-1 rounded border border-primary bg-white dark:bg-slate-800 dark:text-slate-100 px-2 py-1 text-xs focus:outline-none"
                        placeholder="תת סעיף חדש..."
                        autoFocus
                      />
                      <button
                        onClick={() => handleAddSub(cat)}
                        className="rounded bg-primary text-white px-2 py-1 text-[10px] font-medium"
                      >
                        הוסף
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setAddingSubFor(cat);
                        setNewSubName("");
                      }}
                      className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 pt-1"
                    >
                      <Plus className="h-3 w-3" />
                      הוסף תת סעיף
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 4. Data & privacy ───────────────────────────────────────────────────

function DataTab() {
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassified, setReclassified] = useState<ReclassifyResult | null>(null);
  const [reclassifyFailed, setReclassifyFailed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  async function handleClear() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setClearing(true);
    try {
      await clearAllMappings(uid);
      setCleared(true);
      setConfirmClear(false);
      setTimeout(() => setCleared(false), 3000);
    } catch (err) {
      console.error("[Settings] clear mappings failed:", err);
    } finally {
      setClearing(false);
    }
  }

  async function handleReclassify() {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setReclassifying(true);
    setReclassified(null);
    setReclassifyFailed(false);
    try {
      setReclassified(await reapplyRulesToHistory(uid));
    } catch (err) {
      console.error("[Settings] reclassify failed:", err);
      setReclassifyFailed(true);
    } finally {
      setReclassifying(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className={SECTION_TITLE}>
          סיווג תנועות עבר
        </h3>
        <p className={`${SECTION_HINT} mb-3`}>
          מחיל את הכללים הנוכחיים על כל התנועות שכבר יובאו: משלים סעיף לתנועות
          ללא סיווג, ומעביר העברות בין חשבונות, מכירת ני״ע ופדיון פיקדון לסעיף
          "העברות פנימיות" כדי שלא ייספרו כהכנסה או כהוצאה. תנועות שסיווגת
          בעצמך לא ישתנו.
        </p>
        <button
          onClick={handleReclassify}
          disabled={reclassifying}
          className="flex items-center gap-1.5 rounded-lg border border-primary/30 text-primary px-4 py-2 text-sm font-medium hover:bg-primary/5 transition-colors disabled:opacity-50"
        >
          <Wand2 className="h-4 w-4" />
          {reclassifying ? "מסווג..." : "החל כללים חדשים על תנועות עבר"}
        </button>
        {reclassified && (
          <p className="text-xs text-emerald-600 font-medium mt-2">
            {reclassified.expenses + reclassified.incomes === 0
              ? "לא נמצאו תנועות לעדכון."
              : `עודכנו ${reclassified.incomes} הכנסות ו-${reclassified.expenses} הוצאות.`}
          </p>
        )}
        {reclassifyFailed && (
          <p className="text-xs text-red-600 font-medium mt-2">הסיווג נכשל. נסו שוב.</p>
        )}
      </div>

      <div>
        <h3 className={SECTION_TITLE}>
          מיפויים נלמדים
        </h3>
        <p className={`${SECTION_HINT} mb-3`}>
          המערכת לומדת אוטומטית לאיזה סעיף שייך כל בית עסק. איפוס המיפויים
          ימחק את כל הלמידה הזו והמערכת תתחיל ללמוד מחדש.
        </p>

        {confirmClear ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-600 font-medium">
              למחוק את כל המיפויים?
            </span>
            <button
              onClick={handleClear}
              disabled={clearing}
              className="rounded-lg bg-red-500 text-white px-3 py-1.5 text-xs font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {clearing ? "מוחק..." : "אישור מחיקה"}
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500"
            >
              ביטול
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 text-red-600 px-4 py-2 text-sm font-medium hover:bg-red-50 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            איפוס מיפויים נלמדים
          </button>
        )}

        {cleared && (
          <p className="text-xs text-emerald-600 font-medium mt-2">
            כל המיפויים נמחקו בהצלחה.
          </p>
        )}
      </div>

      <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-4 py-3">
        <h3 className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">פרטיות</h3>
        <p className={SECTION_HINT}>
          הנתונים שמורים בחשבון שלכם בלבד ואינם משותפים עם משתמשים אחרים. פרטי ההתחברות לבנק נשמרים מוצפנים בשרת
          הסנכרון ומשמשים רק למשיכת התנועות. ניתוק חשבון במסך הסנכרון מוחק אותם.
        </p>
      </div>
    </div>
  );
}

// ─── Financial profile (inside 1. Accounts & sync) ────────────────────────────────────────────────

function SettingsChipGrid({
  options,
  selected,
  onToggle,
}: {
  options: FinancialOption[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const active = selected.includes(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onToggle(opt.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-150 ${
              active
                ? "bg-primary text-white border-primary shadow-sm"
                : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600 hover:border-slate-300 dark:hover:border-slate-500"
            }`}
          >
            {opt.name}
          </button>
        );
      })}
    </div>
  );
}

function FinancialProfileTab() {
  const [profile, setProfile] = useState<UserFinancialProfile>({
    ...DEFAULT_FINANCIAL_PROFILE,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getFinancialProfile()
      .then((p) => setProfile(p))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const availableClubs = getAvailableClubs(profile.banks, profile.creditCards);
  const availableWallets = getAvailableWallets(profile.consumerClubs);
  const hasSelection = profile.banks.length > 0 || profile.creditCards.length > 0;

  function toggle(key: keyof UserFinancialProfile, id: string) {
    setSaved(false);
    setProfile((prev) => {
      const arr = prev[key];
      const next = {
        ...prev,
        [key]: arr.includes(id)
          ? arr.filter((v) => v !== id)
          : [...arr, id],
      };
      if (key === "banks" || key === "creditCards") {
        const validClubIds = new Set(
          getAvailableClubs(next.banks, next.creditCards).map((c) => c.id),
        );
        next.consumerClubs = next.consumerClubs.filter((c) => validClubIds.has(c));
      }
      if (key === "banks" || key === "creditCards" || key === "consumerClubs") {
        const validWalletIds = new Set(
          getAvailableWallets(next.consumerClubs).map((w) => w.id),
        );
        next.walletsAndVouchers = next.walletsAndVouchers.filter((w) => validWalletIds.has(w));
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveFinancialProfile(profile);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error("[Settings] save financial profile failed:", err);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-400 text-center py-6">טוען פרופיל...</p>;
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        בחרו את המוצרים הפיננסיים שלכם כדי לקבל המלצות חיסכון מותאמות אישית.
      </p>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">בנקים</h3>
        <SettingsChipGrid options={BANKS} selected={profile.banks} onToggle={(id) => toggle("banks", id)} />
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">כרטיסי אשראי</h3>
        <SettingsChipGrid options={CREDIT_CARDS} selected={profile.creditCards} onToggle={(id) => toggle("creditCards", id)} />
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">מועדוני צרכנות</h3>
        {hasSelection ? (
          availableClubs.length > 0 ? (
            <SettingsChipGrid options={availableClubs} selected={profile.consumerClubs} onToggle={(id) => toggle("consumerClubs", id)} />
          ) : (
            <p className="text-xs text-slate-400 py-1">לא נמצאו מועדונים תואמים</p>
          )
        ) : (
          <p className="text-xs text-slate-400 py-1">בחרו בנק או כרטיס כדי לראות מועדונים</p>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">ארנקים ושוברים</h3>
        <SettingsChipGrid options={availableWallets} selected={profile.walletsAndVouchers} onToggle={(id) => toggle("walletsAndVouchers", id)} />
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white text-sm font-bold shadow-sm hover:shadow-md transition-all disabled:opacity-50"
      >
        {saving ? "שומר..." : "שמור פרופיל"}
      </button>

      {saved && (
        <p className="text-xs text-emerald-600 font-medium text-center">
          הפרופיל נשמר בהצלחה.
        </p>
      )}
    </div>
  );
}
