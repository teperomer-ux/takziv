import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { db, getUid, getUidOrNull } from "../lib/firebase";

const DOC_ID = "global";
const NOOP = () => {};

function userRef() {
  return doc(db, "users", getUid(), "settings", DOC_ID);
}

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
  if (!getUidOrNull()) return { ...DEFAULT_SETTINGS };
  const snap = await getDoc(userRef());
  if (!snap.exists()) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...snap.data() } as AppSettings;
}

export async function saveSettings(
  settings: Partial<AppSettings>
): Promise<void> {
  await setDoc(userRef(), settings, { merge: true });
}

export function onSettingsSnapshot(
  callback: (s: AppSettings) => void,
  onError?: (err: Error) => void
): () => void {
  if (!getUidOrNull()) { callback({ ...DEFAULT_SETTINGS }); return NOOP; }
  return onSnapshot(
    userRef(),
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
