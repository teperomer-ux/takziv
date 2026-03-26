import { useState } from "react";
import { X, User, Grid3X3, Database, Palette, Trash2, Pencil, Plus, ChevronDown, ChevronLeft } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import { useCategories } from "../hooks/useCategories";
import { clearAllMappings } from "../services/mappingService";

interface Props {
  open: boolean;
  onClose: () => void;
}

type TabKey = "profile" | "categories" | "data" | "theme";

const TABS: { key: TabKey; label: string; icon: typeof User }[] = [
  { key: "profile", label: "פרופיל והכנסה", icon: User },
  { key: "categories", label: "ניהול סעיפים", icon: Grid3X3 },
  { key: "data", label: "ניהול נתונים", icon: Database },
  { key: "theme", label: "מראה", icon: Palette },
];

export default function SettingsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>("profile");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 pb-10">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-800">הגדרות</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors text-slate-400"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 px-2 overflow-x-auto scrollbar-hide">
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
          {tab === "profile" && <ProfileTab />}
          {tab === "categories" && <CategoriesTab />}
          {tab === "data" && <DataTab />}
          {tab === "theme" && <ThemeTab />}
        </div>
      </div>
    </div>
  );
}

// ─── Profile & Income Tab ──────────────────────────────────────────────────

function ProfileTab() {
  const { settings, updateSettings } = useSettings();
  const [p1Name, setP1Name] = useState(settings.partner1Name);
  const [p2Name, setP2Name] = useState(settings.partner2Name);
  const [p1Inc, setP1Inc] = useState(String(settings.partner1Income || ""));
  const [p2Inc, setP2Inc] = useState(String(settings.partner2Income || ""));
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    await updateSettings({
      partner1Name: p1Name.trim() || "בן/בת זוג 1",
      partner2Name: p2Name.trim() || "בן/בת זוג 2",
      partner1Income: parseFloat(p1Inc.replace(/[^\d.]/g, "")) || 0,
      partner2Income: parseFloat(p2Inc.replace(/[^\d.]/g, "")) || 0,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        הגדירו את שמות בני הזוג וההכנסה החודשית לחישוב השורה התחתונה.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            שם בן/בת זוג 1
          </label>
          <input
            type="text"
            value={p1Name}
            onChange={(e) => setP1Name(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            שם בן/בת זוג 2
          </label>
          <input
            type="text"
            value={p2Name}
            onChange={(e) => setP2Name(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            הכנסה חודשית (₪)
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={p1Inc}
            onChange={(e) => setP1Inc(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
            dir="ltr"
            placeholder="0"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            הכנסה חודשית (₪)
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={p2Inc}
            onChange={(e) => setP2Inc(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
            dir="ltr"
            placeholder="0"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="rounded-lg bg-primary text-white px-5 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          שמור
        </button>
        {saved && (
          <span className="text-xs text-emerald-600 font-medium">נשמר בהצלחה</span>
        )}
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
        <p className="text-sm text-slate-500">
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
    setClearing(true);
    try {
      await clearAllMappings();
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
      <p className="text-sm text-slate-500">בחרו את מראה האפליקציה.</p>

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => updateSettings({ theme: "light" })}
          className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-colors ${
            settings.theme === "light"
              ? "border-primary bg-primary/5"
              : "border-slate-200 hover:border-slate-300"
          }`}
        >
          <div className="h-10 w-10 rounded-full bg-white border border-slate-200 shadow-sm" />
          <span className="text-sm font-medium text-slate-700">בהיר</span>
        </button>
        <button
          onClick={() => updateSettings({ theme: "dark" })}
          className={`flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-colors ${
            settings.theme === "dark"
              ? "border-primary bg-primary/5"
              : "border-slate-200 hover:border-slate-300"
          }`}
        >
          <div className="h-10 w-10 rounded-full bg-slate-800 border border-slate-600 shadow-sm" />
          <span className="text-sm font-medium text-slate-700">כהה</span>
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
