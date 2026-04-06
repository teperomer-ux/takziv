import { useState, useEffect, useMemo } from "react";
import {
  BANKS,
  CREDIT_CARDS,
  DEFAULT_FINANCIAL_PROFILE,
  getAvailableClubs,
  getAvailableWallets,
  type UserFinancialProfile,
  type FinancialOption,
} from "../types/userProfile";
import {
  getFinancialProfile,
  saveFinancialProfile,
} from "../services/userProfileService";

interface Props {
  onDone: () => void;
  onSkip: () => void;
}

type ProfileKey = keyof UserFinancialProfile;

function ChipGrid({
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
            className={`px-3.5 py-2 rounded-full text-sm font-medium border transition-all duration-150 ${
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

export default function SmartSaverOnboarding({ onDone, onSkip }: Props) {
  const [profile, setProfile] = useState<UserFinancialProfile>({
    ...DEFAULT_FINANCIAL_PROFILE,
  });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load existing profile on mount
  useEffect(() => {
    getFinancialProfile()
      .then((p) => setProfile(p))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Dynamically filter clubs based on selected banks & cards
  const availableClubs = useMemo(
    () => getAvailableClubs(profile.banks, profile.creditCards),
    [profile.banks, profile.creditCards],
  );

  // Dynamically filter wallets based on selected clubs
  const availableWallets = useMemo(
    () => getAvailableWallets(profile.consumerClubs),
    [profile.consumerClubs],
  );

  function toggle(key: ProfileKey, id: string) {
    setProfile((prev) => {
      const arr = prev[key];
      const next = {
        ...prev,
        [key]: arr.includes(id)
          ? arr.filter((v) => v !== id)
          : [...arr, id],
      };
      // Cascade: banks/cards → prune clubs → prune wallets
      if (key === "banks" || key === "creditCards") {
        const validClubIds = new Set(
          getAvailableClubs(next.banks, next.creditCards).map((c) => c.id),
        );
        next.consumerClubs = next.consumerClubs.filter((c) =>
          validClubIds.has(c),
        );
      }
      if (key === "banks" || key === "creditCards" || key === "consumerClubs") {
        const validWalletIds = new Set(
          getAvailableWallets(next.consumerClubs).map((w) => w.id),
        );
        next.walletsAndVouchers = next.walletsAndVouchers.filter((w) =>
          validWalletIds.has(w),
        );
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveFinancialProfile(profile);
      onDone();
    } catch (err) {
      console.error("[SmartSaver] save failed:", err);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  const hasSelection =
    profile.banks.length > 0 || profile.creditCards.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onSkip}
      />

      {/* Modal */}
      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5 mb-1">
            <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4.5 w-4.5 text-white"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M8.433 7.418c.155-.103.346-.196.567-.278a5.6 5.6 0 011.108-.282c.108-.017.222-.028.33-.028.376 0 .726.088 1.028.252.302.165.54.398.702.688a2.1 2.1 0 01.252 1.022c0 .41-.1.77-.292 1.08a2.46 2.46 0 01-.752.764c-.197.132-.432.248-.692.34v.74a.75.75 0 01-1.5 0v-1.17a.75.75 0 01.537-.72 2.2 2.2 0 00.62-.326c.166-.124.295-.27.377-.426.082-.158.123-.333.123-.52 0-.202-.044-.378-.13-.524a.86.86 0 00-.372-.348 1.14 1.14 0 00-.556-.128c-.193 0-.39.03-.588.084a3.1 3.1 0 00-.558.19.75.75 0 01-.63-1.362zM10 15a1 1 0 100-2 1 1 0 000 2z" />
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-1.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">
              Smart Saver
            </h2>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            ספרו לנו על המוצרים הפיננסיים שלכם ונמצא לכם הנחות וחסכונות
          </p>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 pb-2">
          {/* Banks */}
          <div className="mb-5">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">
              באיזה בנק/ים יש לך חשבון?
            </h3>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2.5">
              בנקים
            </p>
            <ChipGrid
              options={BANKS}
              selected={profile.banks}
              onToggle={(id) => toggle("banks", id)}
            />
          </div>

          {/* Credit Cards */}
          <div className="mb-5">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">
              אילו כרטיסי אשראי יש לך?
            </h3>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2.5">
              כרטיסי אשראי
            </p>
            <ChipGrid
              options={CREDIT_CARDS}
              selected={profile.creditCards}
              onToggle={(id) => toggle("creditCards", id)}
            />
          </div>

          {/* Consumer Clubs (dynamic) */}
          <div className="mb-5">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">
              לאילו מועדוני צרכנות אתה שייך?
            </h3>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2.5">
              מועדונים — מוצגים לפי הבנקים והכרטיסים שבחרת
            </p>
            {hasSelection ? (
              availableClubs.length > 0 ? (
                <ChipGrid
                  options={availableClubs}
                  selected={profile.consumerClubs}
                  onToggle={(id) => toggle("consumerClubs", id)}
                />
              ) : (
                <p className="text-xs text-slate-400 py-2">
                  לא נמצאו מועדונים תואמים לבחירה הנוכחית
                </p>
              )
            ) : (
              <p className="text-xs text-slate-400 py-2">
                בחרו בנק או כרטיס אשראי כדי לראות מועדונים רלוונטיים
              </p>
            )}
          </div>

          {/* Wallets & Vouchers */}
          <div className="mb-5">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">
              אילו ארנקים דיגיטליים או שוברים אתה משתמש?
            </h3>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2.5">
              ארנקים ושוברים — ארנקי מועדון מוצגים לפי המועדונים שבחרת
            </p>
            <ChipGrid
              options={availableWallets}
              selected={profile.walletsAndVouchers}
              onToggle={(id) => toggle("walletsAndVouchers", id)}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-100 dark:border-slate-700 flex flex-col gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white text-sm font-bold shadow-sm hover:shadow-md transition-all disabled:opacity-50"
          >
            {saving ? "שומר..." : "שמור פרופיל והתחל לחסוך"}
          </button>
          <button
            onClick={onSkip}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            דלג בינתיים
          </button>
        </div>
      </div>
    </div>
  );
}
