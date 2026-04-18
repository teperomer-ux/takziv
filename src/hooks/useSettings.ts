import { useState, useEffect, useCallback, createContext, useContext } from "react";
import {
  onSettingsSnapshot,
  saveSettings as saveSettingsToDb,
  type AppSettings,
  DEFAULT_SETTINGS,
} from "../services/settingsService";

interface SettingsContextValue {
  settings: AppSettings;
  loading: boolean;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loading: true,
  updateSettings: async () => {},
});

export function useSettingsProvider(): SettingsContextValue {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onSettingsSnapshot(
      (s) => {
        setSettings(s);
        setLoading(false);
        // Keep localStorage in sync so the next page load has the right theme
        localStorage.setItem("takziv_theme", s.theme);
        document.documentElement.classList.toggle("dark", s.theme === "dark");
      },
      (err) => {
        console.warn("[useSettings] snapshot error:", err);
        setLoading(false);
      }
    );
  }, []);

  // Migrate from localStorage if Firestore has no income yet
  useEffect(() => {
    if (loading) return;
    if (settings.partner1Income > 0 || settings.partner2Income > 0) return;

    const lsP1 = parseFloat(localStorage.getItem("takziv_income_p1") ?? "0") || 0;
    const lsP2 = parseFloat(localStorage.getItem("takziv_income_p2") ?? "0") || 0;
    if (lsP1 > 0 || lsP2 > 0) {
      saveSettingsToDb({ partner1Income: lsP1, partner2Income: lsP2 }).then(() => {
        localStorage.removeItem("takziv_income_p1");
        localStorage.removeItem("takziv_income_p2");
      });
    }
  }, [loading, settings.partner1Income, settings.partner2Income]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    if (patch.theme) {
      // Mirror to localStorage so the next page load can apply instantly
      localStorage.setItem("takziv_theme", patch.theme);
      document.documentElement.classList.toggle("dark", patch.theme === "dark");
    }
    await saveSettingsToDb(patch);
  }, []);

  return { settings, loading, updateSettings };
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
