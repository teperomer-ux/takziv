import { useState, useEffect } from "react";
import { X, Grid3X3, Database, Palette, Wallet, Trash2, Pencil, Plus, ChevronDown, ChevronLeft } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import { useCategories } from "../hooks/useCategories";
import { clearAllMappings } from "../services/mappingService";
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

type TabKey = "categories" | "data" | "theme" | "financial";

const TABS: { key: TabKey; label: string; icon: typeof Grid3X3 }[] = [
  { key: "categories", label: "ניהול סעיפים", icon: Grid3X3 },
  { key: "data", label: "ניהול נתונים", icon: Database },
  { key: "theme", label: "מראה", icon: Palette },
  { key: "financial", label: "פרופיל פיננסי", icon: Wallet },
];

export default function SettingsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>("categories");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 pb-10">
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
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors text-slate-400"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 dark:border-slate-700 px-2 overflow-x-auto scrollbar-hide">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-slate-400 hover:text-slate-600"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === "categories" && <CategoriesTab />}
          {tab === "data" && <DataTab />}
          {tab === "theme" && <ThemeTab />}
          {tab === "financial" && <FinancialProfileTab />}
        </div>
      </div>
    </div>
  );
}

// ─── Categories Tab ────────────────────────────────────────────────────────

function CategoriesTab() {
  const {
    categories,
    categoryNames,
    addCategory,
    addSubCategory,
    deleteCategory,
    removeSubCategory,
    renameCategory,
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
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {categoryNames.length} סעיפים
        </p>
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
            className="min-w-0 flex-1 rounded-lg border border-primary px-3 py-2 text-sm focus:outline-none"
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
              className="rounded-xl border border-slate-100 bg-white overflow-hidden"
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
                    className="min-w-0 flex-1 rounded border border-primary px-2 py-0.5 text-sm focus:outline-none"
                    autoFocus
                  />
                ) : (
                  <span
                    className="flex-1 text-sm font-medium text-slate-700 cursor-pointer"
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
                <div className="border-t border-slate-50 bg-slate-50/50 px-3 py-2 space-y-1">
                  {subs.length === 0 && (
                    <p className="text-xs text-slate-400 py-1">אין תת סעיפים</p>
                  )}
                  {subs.map((sub) => (
                    <div
                      key={sub}
                      className="flex items-center justify-between py-1 pe-1"
                    >
                      <span className="text-xs text-slate-600">{sub}</span>
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
                        className="min-w-0 flex-1 rounded border border-primary px-2 py-1 text-xs focus:outline-none"
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

// ─── Data Management Tab ───────────────────────────────────────────────────

function DataTab() {
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

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-1">
          מיפויים נלמדים
        </h3>
        <p className="text-xs text-slate-500 mb-3">
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
    </div>
  );
}

// ─── Theme Tab ─────────────────────────────────────────────────────────────

function ThemeTab() {
  const { settings, updateSettings } = useSettings();

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">בחרו את מראה האפליקציה.</p>

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => updateSettings({ theme: "light" })}
          className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-colors ${
            settings.theme === "light"
              ? "border-primary bg-primary/5 dark:bg-primary/10"
              : "border-slate-200 dark:border-slate-600 hover:border-slate-300"
          }`}
        >
          <div className="h-10 w-10 rounded-full bg-white border border-slate-200 shadow-sm" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">בהיר</span>
        </button>
        <button
          onClick={() => updateSettings({ theme: "dark" })}
          className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-colors ${
            settings.theme === "dark"
              ? "border-primary bg-primary/5 dark:bg-primary/10"
              : "border-slate-200 dark:border-slate-600 hover:border-slate-300"
          }`}
        >
          <div className="h-10 w-10 rounded-full bg-slate-800 border border-slate-600 shadow-sm" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">כהה</span>
        </button>
      </div>

      {settings.theme === "dark" && (
        <p className="text-xs text-slate-400">
          מצב כהה ישפיע על הרקע הראשי וצבעי הכרטיסים.
        </p>
      )}
    </div>
  );
}

// ─── Financial Profile Tab ────────────────────────────────────────────────

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
