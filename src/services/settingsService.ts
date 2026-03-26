import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";

const ref = doc(db, "appSettings", "global");

export interface AppSettings {
  partner1Name: string;
  partner2Name: string;
  partner1Income: number;
  partner2Income: number;
  theme: "light" | "dark";
}

export const DEFAULT_SETTINGS: AppSettings = {
  partner1Name: "בן/בת זוג 1",
  partner2Name: "בן/בת זוג 2",
  partner1Income: 0,
  partner2Income: 0,
  theme: "light",
};

export async function getSettings(): Promise<AppSettings> {
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...snap.data() } as AppSettings;
}

export async function saveSettings(
  settings: Partial<AppSettings>
): Promise<void> {
  await setDoc(ref, settings, { merge: true });
}

export function onSettingsSnapshot(
  callback: (s: AppSettings) => void,
  onError?: (err: Error) => void
): () => void {
  return onSnapshot(
    ref,
    (snap) => {
      if (snap.exists()) {
        callback({ ...DEFAULT_SETTINGS, ...snap.data() } as AppSettings);
      } else {
        callback({ ...DEFAULT_SETTINGS });
      }
    },
    onError
  );
}
